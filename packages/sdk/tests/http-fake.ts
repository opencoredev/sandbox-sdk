// A scriptable local HTTP/1.1 server for adapter and transport tests. Each route holds a queue of replies,
// one per request: JSON, a chunked stream (optionally cut mid-body), a delay, a Retry-After, a dropped
// connection, or a custom handler. Every request is recorded with its headers and body.
//
//   const server = await fakeServer();
//   server.on("GET /v1/sandboxes/{id}", { status: 503, headers: { "retry-after": "0" } }, { json: { id: "sb" } });
//   ... point the client at server.url ...
//   expect(server.requests).toHaveLength(2);
//   await server.close();
import { isString } from "../src/shared/narrow.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One scripted reply. */
export type Reply =
  | {
      status?: number;
      headers?: Record<string, string>;
      /** Sent as JSON with `content-type: application/json`. */
      json?: unknown;
      /** Sent as is. */
      body?: string | Uint8Array;
      /** Wait this long before sending headers. */
      delayMs?: number;
    }
  | {
      status?: number;
      headers?: Record<string, string>;
      /** Sent as separate chunks with chunked transfer encoding, flushed one by one. */
      stream: (string | Uint8Array)[];
      /** Wait between chunks. Default: 5 ms. */
      intervalMs?: number;
      /** Destroy the socket after the last chunk instead of ending the body: a mid-stream disconnect. */
      cut?: boolean;
      /** Keep the response open after the last chunk until the client goes away (for idle timeouts and cancellation). */
      hold?: boolean;
      delayMs?: number;
    }
  /** Read the request, then destroy the socket without a response. */
  | { drop: true }
  /** Never answer. */
  | { hang: true }
  | ((request: RecordedRequest, response: ServerResponse) => void | Promise<void>);

export interface RecordedRequest {
  method: string;
  /** Path and query, as sent. */
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface FakeServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly origin: string;
  readonly requests: RecordedRequest[];
  /**
   * Queue replies for `METHOD /path`. `{name}` segments match any one segment; a route without a query
   * matches any query. The last reply repeats once the queue is down to one.
   */
  on(route: string, ...replies: Reply[]): FakeServer;
  /** Requests whose `METHOD path` (no query) matches `route`. */
  calls(route: string): RecordedRequest[];
  /** Resolves when a response the server holds open is closed by the client. */
  closed(): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function matcher(route: string) {
  const [method, path = "/"] = route.split(" ");

  const pattern = new RegExp(
    `^${path
      .split("?")[0]!
      .split("/")
      .map((part) =>
        /^\{\w+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/")}$`,
  );

  return (request: { method?: string; url?: string }) =>
    request.method === method && pattern.test((request.url ?? "").split("?")[0]!);
}

export async function fakeServer(): Promise<FakeServer> {
  const routes: { match: ReturnType<typeof matcher>; replies: Reply[] }[] = [];
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let onClosed: (() => void)[] = [];

  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));

    const recorded: RecordedRequest = {
      method: incoming.method ?? "",
      url: incoming.url ?? "",
      headers: incoming.headers,
      body: Buffer.concat(chunks),
    };

    requests.push(recorded);
    const route = routes.find((candidate) => candidate.match(incoming));

    if (!route) {
      response.writeHead(404, { "content-type": "application/json" }).end(
        JSON.stringify({
          code: "no_route",
          message: `fake server has no route for ${recorded.method} ${recorded.url}`,
        }),
      );

      return;
    }

    const reply = route.replies.length > 1 ? route.replies.shift()! : route.replies[0]!;
    response.on("close", () => {
      if (!response.writableFinished) {
        const waiting = onClosed;
        onClosed = [];

        for (const done of waiting) done();
      }
    });

    if (typeof reply === "function") {
      await reply(recorded, response);

      return;
    }

    if ("drop" in reply) {
      incoming.socket.destroy();

      return;
    }

    if ("hang" in reply) return;

    if (reply.delayMs) await sleep(reply.delayMs);

    if ("stream" in reply) {
      response.writeHead(reply.status ?? 200, {
        "content-type": "application/octet-stream",
        ...reply.headers,
      });
      response.flushHeaders();

      for (const part of reply.stream) {
        if (response.destroyed) return;
        response.write(part);
        await sleep(reply.intervalMs ?? 5);
      }

      if (reply.cut) {
        incoming.socket.destroy();

        return;
      }

      if (reply.hold) return;
      response.end();

      return;
    }

    const body = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.body ?? "");
    response.writeHead(reply.status ?? 200, {
      ...(reply.json !== undefined ? { "content-type": "application/json" } : undefined),
      ...reply.headers,
    });
    response.end(body);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a server listening on TCP reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const fake: FakeServer = {
    url: origin,
    origin,
    requests,
    on(route, ...replies) {
      if (!replies.length) throw new Error("fakeServer.on needs at least one reply");
      routes.unshift({ match: matcher(route), replies });

      return fake;
    },
    calls(route) {
      const match = matcher(route);

      return requests.filter((request) => match(request));
    },
    closed() {
      return new Promise((resolve) => onClosed.push(resolve));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  return fake;
}

/** A body built from chunks, for stream parser tests without a server. `error` makes the read after the last chunk fail. */
export function chunked(
  parts: (string | Uint8Array)[],
  options: { error?: Error } = {},
): ReadableStream<Uint8Array> & { cancelled: () => boolean } {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index < parts.length) {
          const part = parts[index++]!;
          controller.enqueue(isString(part) ? encoder.encode(part) : part);

          return;
        }

        if (options.error) controller.error(options.error);
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );

  return Object.assign(stream, { cancelled: () => cancelled });
}

/** Splits `bytes` into pieces of `size` bytes, to put frame and UTF-8 boundaries inside chunks. */
export function pieces(bytes: Uint8Array | string, size: number): Uint8Array[] {
  const data = isString(bytes) ? new TextEncoder().encode(bytes) : bytes;
  const out: Uint8Array[] = [];

  for (let i = 0; i < data.byteLength; i += size) out.push(data.subarray(i, i + size));

  return out;
}

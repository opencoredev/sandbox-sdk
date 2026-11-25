// A local stand-in for Maritime's Virtual machines API (https://maritime.sh/docs/ephemeral-sandboxes), for the
// adapter's tests and the no-peer consumer smoke. Each sandbox is a temporary directory; `/workspace` and
// `/tmp/.sandbox-sdk` in commands and paths map into it, and commands run as real processes. The control
// plane is served under `/v1`, each sandbox's data plane under `/dp/<id>/v1`. Only the routes the adapter
// uses are served: create, read, list, end, pause, urls, usage, info, save and snapshots, and the data
// plane's commands and files.
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "../src/shared/json.js";
import { isString } from "../src/shared/narrow.js";

export interface FakeSandbox {
  id: string;
  root: string;
  metadata: Record<string, string>;
  env: Record<string, string>;
  createdAt: string;
  endedAt: string | null;
  state: "running" | "paused" | "ended";
  secret: string;
  urlToken: string;
  children: Set<ChildProcess>;
}

export interface MaritimeFake {
  /** `http://127.0.0.1:<port>`, for `maritime({ baseUrl })`. */
  readonly url: string;
  readonly sandboxes: ReadonlyMap<string, FakeSandbox>;
  readonly snapshots: ReadonlyMap<string, { source: string; root: string }>;
  /** Every request the fake answered: method, path with query, and the headers and body it read. */
  readonly requests: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }[];
  close(): Promise<void>;
}

const mapped = (sandbox: FakeSandbox, text: string) =>
  text.replace(/\/workspace|\/tmp\/\.sandbox-sdk/g, (path) => join(sandbox.root, path));

const strings = z.record(z.string(), z.string());

const createBody = z.looseObject({
  from: z.string().optional(),
  metadata: strings.optional(),
  env: strings.optional(),
  name: z.string().optional(),
});

const commandBody = z.looseObject({
  cmd: z.union([z.string(), z.array(z.string()).min(1)]),
  cwd: z.string().optional(),
  env: strings.optional(),
  stdin: z.string().optional(),
  timeoutSeconds: z.number().optional(),
});

type CommandBody = z.infer<typeof commandBody>;

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks);
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const signalNames = new Map([
  ["SIGKILL", "SIGKILL"],
  ["SIGTERM", "SIGTERM"],
]);

export async function maritimeFake(): Promise<MaritimeFake> {
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, { source: string; root: string }>();
  const created = new Map<string, JsonValue>();
  const requests: MaritimeFake["requests"] = [];
  let origin = "";

  const json = (response: ServerResponse, status: number, value?: JsonValue) =>
    response
      .writeHead(status, value === undefined ? {} : { "content-type": "application/json" })
      .end(value === undefined ? undefined : JSON.stringify(value));

  const failure = (response: ServerResponse, status: number, code: string) =>
    json(response, status, { code, message: code, requestId: "req_fake" });

  const info = (sandbox: FakeSandbox): JsonValue => ({
    id: sandbox.id,
    name: null,
    state: sandbox.state,
    size: "small",
    resources: { vcpu: 2, memoryMib: 4096, diskGib: 12 },
    from: "base",
    network: { egress: "all" },
    dataPlaneUrl: `${origin}/dp/${sandbox.id}/v1`,
    secret: sandbox.secret,
    urlToken: sandbox.urlToken,
    publicPorts: [],
    metadata: sandbox.metadata,
    createdAt: sandbox.createdAt,
    endedAt: sandbox.endedAt,
  });

  function end(sandbox: FakeSandbox) {
    for (const child of sandbox.children)
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }

    sandbox.state = "ended";
    sandbox.endedAt ??= new Date().toISOString();
  }

  /** Runs one command; `emit` gets output as it arrives. Resolves with Maritime's Command object. */
  function run(
    sandbox: FakeSandbox,
    command: CommandBody,
    emit: (stream: "stdout" | "stderr", text: string) => void,
  ) {
    const argv = isString(command.cmd) ? ["sh", "-c", command.cmd] : command.cmd;
    const [program = "sh", ...args] = argv.map((part) => mapped(sandbox, part));
    const cwd = mapped(sandbox, command.cwd ?? "/workspace");
    const startedAt = new Date().toISOString();

    const child = spawn(program, args, {
      cwd: cwd === "/" ? sandbox.root : cwd,
      env: { ...process.env, ...sandbox.env, ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    sandbox.children.add(child);
    const out = { stdout: "", stderr: "" };

    // Output names guest paths, as a real sandbox would: the sandbox's directory is left out.
    const guest = (data: Buffer) => data.toString().split(sandbox.root).join("");

    for (const stream of ["stdout", "stderr"] as const)
      child[stream].on("data", (data: Buffer) => {
        const text = guest(data);
        out[stream] += text;
        emit(stream, text);
      });
    child.stdin.on("error", () => {});
    child.stdin.end(command.stdin);
    let timedOut = false;

    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      (command.timeoutSeconds ?? 60) * 1000,
    );

    return new Promise<{ timedOut: boolean; command: JsonValue }>((resolve) =>
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        sandbox.children.delete(child);
        resolve({
          timedOut,
          command: {
            id: `cmd-${crypto.randomUUID().slice(0, 12)}`,
            sandboxId: sandbox.id,
            cmd: command.cmd,
            cwd: command.cwd ?? "/home/user",
            background: false,
            state: signal === null ? "exited" : "killed",
            exitCode: code,
            signal: signal === null ? null : (signalNames.get(signal) ?? "SIGKILL"),
            startedAt,
            endedAt: new Date().toISOString(),
            stdout: out.stdout,
            stderr: out.stderr,
            truncated: false,
          },
        });
      }),
    );
  }

  async function dataPlane(
    sandbox: FakeSandbox,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    route: string,
    payload: Buffer,
  ) {
    if (request.headers["x-maritime-token"] !== sandbox.secret)
      return failure(response, 401, "unauthenticated");

    if (sandbox.state === "ended") return failure(response, 410, "sandbox_ended");

    // Any data-plane call wakes a paused sandbox.
    sandbox.state = "running";
    const method = request.method ?? "GET";

    if (route === "/commands" && method === "POST") {
      const command = commandBody.parse(JSON.parse(payload.toString()));

      if (
        command.cwd !== undefined &&
        !(await exists(mapped(sandbox, command.cwd))) &&
        command.cwd !== "/"
      )
        return failure(response, 400, "invalid_request");

      if (request.headers.accept === "text/event-stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });

        const done = await run(sandbox, command, (stream, text) => {
          if (!response.writableEnded)
            response.write(`event: ${stream}\ndata: ${JSON.stringify(text)}\n\n`);
        });

        if (response.writableEnded || response.destroyed) return;

        if (done.timedOut)
          return response.end(
            `event: error\ndata: ${JSON.stringify({ code: "command_timeout", command: done.command, message: "the command passed its time limit and was killed" })}\n\n`,
          );

        return response.end(`event: result\ndata: ${JSON.stringify(done.command)}\n\n`);
      }

      const done = await run(sandbox, command, () => {});

      return json(response, 200, done.command);
    }

    if (route === "/files") {
      const path = url.searchParams.get("path") ?? "";
      const target = mapped(sandbox, path);

      if (method === "PUT") {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, payload);

        return json(response, 204);
      }

      let bytes: Buffer;

      try {
        bytes = await readFile(target);
      } catch {
        return failure(response, 404, "file_not_found");
      }

      return response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
    }

    return failure(response, 404, "invalid_request");
  }

  async function makeSandbox(input: z.infer<typeof createBody>): Promise<FakeSandbox> {
    const id = `sbx-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const sandbox: FakeSandbox = {
      id,
      root: await mkdtemp(join(tmpdir(), "sdk-maritime-")),
      metadata: input.metadata ?? {},
      env: input.env ?? {},
      createdAt: new Date().toISOString(),
      endedAt: null,
      state: "running",
      secret: `mst_${crypto.randomUUID().replace(/-/g, "")}`,
      urlToken: `mut_${crypto.randomUUID().replace(/-/g, "")}`,
      children: new Set(),
    };

    const snapshot = input.from === undefined ? undefined : snapshots.get(input.from);

    if (snapshot) await cp(snapshot.root, sandbox.root, { recursive: true });
    await mkdir(join(sandbox.root, "tmp"), { recursive: true });
    sandboxes.set(id, sandbox);

    return sandbox;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const payload = await body(request);
    const method = request.method ?? "GET";

    const headers = Object.fromEntries(
      Object.entries(request.headers).flatMap(([k, v]) => (isString(v) ? [[k, v]] : [])),
    );

    requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      headers,
      body: payload.toString(),
    });

    const parts = url.pathname.split("/");

    if (parts[1] === "dp") {
      const sandbox = sandboxes.get(parts[2] ?? "");

      if (!sandbox) return failure(response, 404, "sandbox_not_found");

      return dataPlane(sandbox, request, response, url, `/${parts.slice(4).join("/")}`, payload);
    }

    if (request.headers.authorization !== "Bearer fake-key")
      return failure(response, 401, "unauthenticated");

    if (parts[1] !== "v1") return failure(response, 404, "resource_not_found");
    const [, , collection, id, route] = parts;

    if (collection === "snapshots" && id) {
      const snapshot = snapshots.get(id);

      if (!snapshot) return failure(response, 404, "snapshot_not_found");

      if (method === "DELETE") {
        snapshots.delete(id);
        await rm(snapshot.root, { recursive: true, force: true });

        return json(response, 200, { deleted: true });
      }

      return json(response, 200, {
        name: id,
        sourceSandboxId: snapshot.source,
        size: "small",
        screen: "none",
        storedBytes: 0,
        createdAt: new Date().toISOString(),
      });
    }

    if (collection !== "sandboxes") return failure(response, 404, "resource_not_found");

    if (!id) {
      if (method === "GET") {
        const states = url.searchParams.getAll("state");

        const filters = [...url.searchParams].flatMap(([k, v]) => {
          const match = /^metadata\[(.+)\]$/.exec(k);

          return match?.[1] ? [[match[1], v] as const] : [];
        });

        return json(response, 200, {
          data: [...sandboxes.values()].flatMap((s) =>
            (states.length === 0 || states.includes(s.state)) &&
            filters.every(([k, v]) => s.metadata[k] === v)
              ? [info(s)]
              : [],
          ),
          nextCursor: null,
        });
      }

      const key = request.headers["idempotency-key"];
      const replay = isString(key) ? created.get(key) : undefined;

      if (replay !== undefined) return json(response, 200, replay);
      const sandbox = await makeSandbox(createBody.parse(JSON.parse(payload.toString())));
      const answer = info(sandbox);

      if (isString(key)) created.set(key, answer);

      return json(response, 201, answer);
    }

    const sandbox = sandboxes.get(id);

    if (!sandbox) return failure(response, 404, "sandbox_not_found");

    if (route === undefined && method === "GET") return json(response, 200, info(sandbox));

    if (route === undefined && method === "DELETE") {
      end(sandbox);

      return json(response, 200, info(sandbox));
    }

    if (sandbox.state === "ended") return failure(response, 410, "sandbox_ended");

    if (route === "pause" && method === "POST") {
      if (sandbox.state === "paused") return failure(response, 409, "invalid_state");
      sandbox.state = "paused";

      return json(response, 200, info(sandbox));
    }

    if (route === "urls" && method === "POST") {
      const { port, token } = z
        .object({ port: z.number(), token: z.boolean() })
        .parse(JSON.parse(payload.toString()));

      return json(response, 200, {
        url: `https://${port}-${sandbox.id}.fake.mtm.test/${token ? `?token=${sandbox.urlToken}` : ""}`,
      });
    }

    if (route === "usage" && method === "GET")
      return json(response, 200, {
        sandboxId: sandbox.id,
        state: sandbox.state,
        cpuPercent: 1.5,
        memoryUsedMib: 100,
        memoryMib: 4096,
        diskUsedGib: 1,
        diskGib: 12,
        idleSeconds: 0,
        runningCommands: sandbox.children.size,
      });

    if (route === "save" && method === "POST") {
      const { name } = z.object({ name: z.string() }).parse(JSON.parse(payload.toString()));

      if (snapshots.has(name)) return failure(response, 409, "snapshot_exists");
      const root = await mkdtemp(join(tmpdir(), "sdk-maritime-snap-"));
      await cp(sandbox.root, root, { recursive: true });
      snapshots.set(name, { source: sandbox.id, root });

      return json(response, 200, {
        name,
        sourceSandboxId: sandbox.id,
        size: "small",
        screen: "none",
        storedBytes: 0,
        createdAt: new Date().toISOString(),
      });
    }

    return failure(response, 404, "invalid_request");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || isString(address)) throw new Error("The Maritime fake has no TCP port");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    url: origin,
    sandboxes,
    snapshots,
    requests,
    async close() {
      for (const sandbox of sandboxes.values()) end(sandbox);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(
        [...sandboxes.values(), ...snapshots.values()].map((s) =>
          rm(s.root, { recursive: true, force: true }),
        ),
      );
    },
  };
}

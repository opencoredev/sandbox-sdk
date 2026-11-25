import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** One container as the fake daemon holds it. */
export interface FakeContainer {
  readonly labels: Record<string, string>;
  running: boolean;
}

/**
 * A Docker Engine API on a unix socket in a fresh temp directory: just the calls the local
 * adapter and the bench make for listing, inspecting, stopping and removing containers, plus
 * `/info`. It answers only what it holds, so a read sent to the wrong daemon sees nothing.
 */
export interface FakeDocker {
  readonly socketPath: string;
  /** `unix://` URL for `DOCKER_HOST` or the adapter's `dockerHost` option. */
  readonly host: string;
  readonly containers: Map<string, FakeContainer>;
  /** Every request as `METHOD path`, without the API version prefix or query. */
  readonly requests: string[];
  /** The daemon's `/info` ID; `null` makes `/info` answer 500. */
  daemonId: string | null;
  close(): Promise<void>;
}

/** What `/info` answers; `null` makes it fail. */
interface DaemonState {
  daemonId: string | null;
}

const created = "2026-11-20T00:00:00.000000000Z";

/** Docker's `filters` query, as the local adapter sends it: `{"label": ["key=value", ...]}`. */
const filtersSchema = z.object({ label: z.array(z.string()).default([]) });

function matches(labels: Record<string, string>, filters: string | null) {
  if (filters === null) return true;

  return filtersSchema.parse(JSON.parse(filters)).label.every((pair) => {
    const [key, ...rest] = pair.split("=");

    return labels[key ?? ""] === rest.join("=");
  });
}

async function listen(server: Server, socketPath: string) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

/** Start a fake daemon. Pass `socketPath` to serve on a path another daemon used before. */
export async function fakeDocker(
  daemonId: string,
  socketPath?: string,
): Promise<FakeDocker & { readonly dir: string | null }> {
  const dir = socketPath === undefined ? await mkdtemp(join(tmpdir(), "bench-docker-")) : null;
  const path = socketPath ?? join(dir ?? "", "docker.sock");
  const containers = new Map<string, FakeContainer>();
  const requests: string[] = [];

  const state: DaemonState = { daemonId };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://docker");
    const route = url.pathname.replace(/^\/v[\d.]+/, "");
    requests.push(`${req.method} ${route}`);

    const json = (status: number, text: string) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(text);
    };

    if (req.method === "GET" && route === "/info") {
      if (state.daemonId === null) return json(500, JSON.stringify({ message: "info failed" }));

      return json(200, JSON.stringify({ ID: state.daemonId, Name: "fake" }));
    }

    if (req.method === "GET" && route === "/containers/json")
      return json(
        200,
        JSON.stringify(
          [...containers].flatMap(([Id, c]) =>
            matches(c.labels, url.searchParams.get("filters")) ? [{ Id }] : [],
          ),
        ),
      );

    const match = /^\/containers\/([^/]+)(\/json|\/stop|\/unpause)?$/.exec(route);
    const id = decodeURIComponent(match?.[1] ?? "");
    const container = containers.get(id);

    if (!match || !container)
      return json(404, JSON.stringify({ message: `No such container: ${id}` }));

    if (req.method === "GET" && match[2] === "/json")
      return json(
        200,
        JSON.stringify({
          Id: id,
          Created: created,
          Config: { Labels: container.labels },
          State: {
            Running: container.running,
            Paused: false,
            Status: container.running ? "running" : "exited",
          },
        }),
      );

    if (req.method === "POST" && match[2] === "/stop") {
      container.running = false;
      res.writeHead(204).end();

      return;
    }

    if (req.method === "DELETE" && match[2] === undefined) {
      containers.delete(id);
      res.writeHead(204).end();

      return;
    }

    json(404, JSON.stringify({ message: "unsupported" }));
  });

  await listen(server, path);

  return {
    dir,
    socketPath: path,
    host: `unix://${path}`,
    containers,
    requests,
    get daemonId() {
      return state.daemonId;
    },
    set daemonId(value) {
      state.daemonId = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));

      if (dir !== null) await rm(dir, { recursive: true, force: true });
    },
  };
}

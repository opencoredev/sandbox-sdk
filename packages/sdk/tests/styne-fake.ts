// A local stand-in for Styne's REST API (https://docs.styne.ai), for the adapter's tests and the no-peer
// consumer smoke. Each sandbox is a temporary directory; `/workspace` and `/tmp/.sandbox-sdk` in commands and
// paths map into it, and commands run as real processes. Git's system config goes to the sandbox's own file,
// so the adapter's setup never touches the host's. Only the routes the adapter's basic paths use are served:
// create, read, list, delete, exec, commands and files.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "../src/shared/json.js";
import { isString } from "../src/shared/narrow.js";

interface FakeSandbox {
  id: string;
  root: string;
  metadata: Record<string, string>;
  env: Record<string, string>;
  startedAt: string;
  ended: boolean;
}

export interface StyneFake {
  /** `http://127.0.0.1:<port>`, for `styne({ baseUrl })`. */
  readonly url: string;
  readonly sandboxes: ReadonlyMap<string, FakeSandbox>;
  close(): Promise<void>;
}

const mapped = (sandbox: FakeSandbox, text: string) =>
  text.replace(/\/workspace|\/tmp\/\.sandbox-sdk/g, (path) => join(sandbox.root, path));

const strings = z.record(z.string(), z.string());

/** The fields of a create body and of exec and command lines that the fake reads. */
const requestLine = z.looseObject({
  argv: z.array(z.string()).min(1).optional(),
  envs: strings.optional(),
  stdin: z.union([z.boolean(), z.string()]).optional(),
  metadata: strings.optional(),
  envVars: strings.optional(),
});

type RequestLine = z.infer<typeof requestLine>;

/** The JSON lines of a request body. */
function lines(body: string): RequestLine[] {
  return body
    .split("\n")
    .flatMap((line) => (line.trim() ? [requestLine.parse(JSON.parse(line))] : []));
}

/** One line of an exec answer before its exit. */
type Frame = { started: { pid: number } } | { stdout: string } | { stderr: string };

function run(
  sandbox: FakeSandbox,
  start: RequestLine,
  stdin: Buffer | undefined,
  emit: (frame: Frame) => void,
): Promise<{ exitCode: number; signal: number }> {
  if (!start.argv) throw new Error("the fake takes commands as argv");
  const [command = "sh", ...args] = start.argv.map((part) => mapped(sandbox, part));
  const envs = start.envs ?? {};

  const child = spawn(command, args, {
    cwd: join(sandbox.root, "workspace"),
    env: {
      ...process.env,
      ...sandbox.env,
      ...envs,
      GIT_CONFIG_SYSTEM: join(sandbox.root, "gitconfig"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  emit({ started: { pid: child.pid ?? 0 } });

  // Output names guest paths, as a real sandbox would: the sandbox's directory is left out.
  const guest = (data: Buffer) =>
    Buffer.from(data.toString().split(sandbox.root).join("")).toString("base64");

  child.stdout.on("data", (data: Buffer) => emit({ stdout: guest(data) }));
  child.stderr.on("data", (data: Buffer) => emit({ stderr: guest(data) }));
  child.stdin.end(stdin);

  return new Promise((resolve) =>
    child.on("close", (code, signal) =>
      resolve({ exitCode: code ?? -1, signal: signal === null ? 0 : 9 }),
    ),
  );
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks);
}

export async function styneFake(): Promise<StyneFake> {
  const sandboxes = new Map<string, FakeSandbox>();

  const json = (response: ServerResponse, status: number, value?: JsonValue) =>
    response
      .writeHead(status, value === undefined ? {} : { "content-type": "application/json" })
      .end(value === undefined ? undefined : JSON.stringify(value));

  const failure = (response: ServerResponse, status: number, code: string) =>
    json(response, status, { code: status, error_code: code, message: code, origin: "client" });

  const info = (sandbox: FakeSandbox) => ({
    templateID: "default",
    sandboxID: sandbox.id,
    startedAt: sandbox.startedAt,
    state: "running",
    metadata: sandbox.metadata,
    domain: "fake.styne.test",
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const payload = await body(request);
    const [, root, id, route, ...rest] = url.pathname.split("/");
    const method = request.method ?? "GET";

    if (root !== "sandboxes") return failure(response, 404, "not_found");

    if (id === undefined || id === "") {
      if (method === "GET") {
        const filter = new URLSearchParams(url.searchParams.get("metadata") ?? "");

        return json(
          response,
          200,
          [...sandboxes.values()].flatMap((s) =>
            !s.ended && [...filter].every(([k, v]) => s.metadata[k] === v) ? [info(s)] : [],
          ),
        );
      }

      const [start = {}] = lines(payload.toString());

      const sandbox: FakeSandbox = {
        id: `vm${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        root: await mkdtemp(join(tmpdir(), "sdk-styne-")),
        metadata: start.metadata ?? {},
        env: start.envVars ?? {},
        startedAt: new Date().toISOString(),
        ended: false,
      };

      await mkdir(join(sandbox.root, "workspace"));
      await mkdir(join(sandbox.root, "tmp"));
      sandboxes.set(sandbox.id, sandbox);

      return json(response, 201, {
        sandboxID: sandbox.id,
        domain: "fake.styne.test",
        trafficAccessToken: `traffic-${sandbox.id}`,
      });
    }

    const sandbox = sandboxes.get(id);

    if (!sandbox) return failure(response, 404, "not_found");

    if (sandbox.ended)
      return method === "DELETE"
        ? failure(response, 404, "not_found")
        : failure(response, 410, "sandbox_ended");

    if (route === undefined && method === "GET") return json(response, 200, info(sandbox));

    if (route === undefined && method === "DELETE") {
      sandbox.ended = true;
      await rm(sandbox.root, { recursive: true, force: true });

      return json(response, 204);
    }

    if (route === "exec" && method === "POST") {
      const [start = {}, ...more] = lines(payload.toString());

      const stdin = Buffer.concat(
        more.flatMap((line) => (isString(line.stdin) ? [Buffer.from(line.stdin, "base64")] : [])),
      );

      response.writeHead(200, { "content-type": "application/x-ndjson" });

      const exit = await run(sandbox, start, start.stdin === true ? stdin : undefined, (frame) =>
        response.write(`${JSON.stringify(frame)}\n`),
      );

      response.end(`${JSON.stringify({ exit: { ...exit, timedOut: false } })}\n`);

      return;
    }

    if (route === "commands" && method === "POST") {
      const [start = {}] = lines(payload.toString());
      const out = { stdout: "", stderr: "" };

      const exit = await run(sandbox, start, undefined, (frame) => {
        if ("stdout" in frame) out.stdout += Buffer.from(frame.stdout, "base64").toString();

        if ("stderr" in frame) out.stderr += Buffer.from(frame.stderr, "base64").toString();
      });

      return json(response, 200, { ...out, exitCode: exit.exitCode, timedOut: false });
    }

    if (route === "files" && rest.length === 0) {
      const path = url.searchParams.get("path") ?? "";
      const target = mapped(sandbox, path.startsWith("/") ? path : `/root/${path}`);

      if (method === "PUT") {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, payload);

        return json(response, 200, { path, type: "file" });
      }

      try {
        return response.writeHead(200).end(await readFile(target));
      } catch {
        return failure(response, 404, "not_found");
      }
    }

    return failure(response, 405, "method_not_allowed");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || isString(address)) throw new Error("The Styne fake has no TCP port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    sandboxes,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(
        [...sandboxes.values()].map((s) => rm(s.root, { recursive: true, force: true })),
      );
    },
  };
}

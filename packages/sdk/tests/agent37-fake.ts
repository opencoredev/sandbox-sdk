// A local stand-in for Agent 37's Sandbox API (https://www.agent37.com/docs/agents-api/instances), for the
// adapter's tests. Each instance is a temporary directory; `/workspace` and `/tmp/.sandbox-sdk` in commands
// map into it, and commands run as real `sh -c` processes, as the user running the tests. The control plane
// is served under `/v1`, the exec host under `/exec/v1`. Only the routes the adapter uses are served:
// create, list, read, delete, sleep, start, stop, fork, signed URLs and public ports, and exec.
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { JsonValue } from "../src/shared/json.js";
import { isString } from "../src/shared/narrow.js";

export interface FakeInstance {
  id: string;
  root: string;
  metadata: Record<string, string>;
  env: Record<string, string>;
  status: "running" | "sleeping" | "stopped";
  created: number;
  children: Set<ChildProcess>;
}

export interface Agent37Fake {
  /** `http://127.0.0.1:<port>`, for `agent37({ baseUrl, execUrl: \`\${url}/exec\` })`. */
  readonly url: string;
  readonly instances: ReadonlyMap<string, FakeInstance>;
  /** Every request the fake answered: method, path with query, and the headers and body it read. */
  readonly requests: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }[];
  /** Answers the next `count` exec requests with `504 try_again` after running them, as a 15-minute command would. */
  stallExec(count: number): void;
  close(): Promise<void>;
}

const strings = z.record(z.string(), z.string());

const createBody = z.looseObject({
  template: z.string().optional(),
  metadata: strings.optional(),
  env: strings.optional(),
  resources: z.looseObject({ cpu: z.number(), memory: z.number() }).optional(),
});

const execBody = z.looseObject({
  command: z.string(),
  user: z.literal("root").optional(),
  name: z.string().optional(),
  background: z.boolean().optional(),
});

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks);
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

export async function agent37Fake(): Promise<Agent37Fake> {
  const instances = new Map<string, FakeInstance>();
  const requests: Agent37Fake["requests"] = [];
  /** Named exec runs, so a resend with the same name gets that run's answer. */
  const runs = new Map<string, Promise<JsonValue>>();
  let stalls = 0;
  let origin = "";

  const json = (response: ServerResponse, status: number, value?: JsonValue) =>
    response
      .writeHead(status, value === undefined ? {} : { "content-type": "application/json" })
      .end(value === undefined ? undefined : JSON.stringify(value));

  const failure = (response: ServerResponse, status: number, code: string) =>
    json(response, status, { error: { code, message: code } });

  const mapped = (instance: FakeInstance, text: string) =>
    text.replace(/\/workspace|\/tmp\/\.sandbox-sdk/g, (path) => join(instance.root, path));

  const info = (instance: FakeInstance): JsonValue => ({
    id: instance.id,
    status: instance.status,
    status_reason: null,
    template: "agent37-base",
    type: "default",
    region: "us",
    resources: { cpu: 2, memory: 4, disk: 4 },
    url: `https://${instance.id}.agent37.app`,
    public_ports: [],
    name: "sandbox-sdk",
    metadata: instance.metadata,
    network: "allow-all",
    past_due: false,
    created: instance.created,
  });

  function kill(instance: FakeInstance) {
    for (const child of instance.children)
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
  }

  /**
   * Runs one exec command, in its own process group so a delete can kill it. The command goes through a
   * script file rather than `sh -c`'s argument, which Linux caps at 128 KiB: Agent 37 takes commands up to
   * its 1 MB body cap.
   */
  async function run(instance: FakeInstance, command: string): Promise<JsonValue> {
    const script = join(instance.root, `.exec-${crypto.randomUUID()}.sh`);
    await writeFile(script, mapped(instance, command));

    const child = spawn("sh", [script], {
      cwd: instance.root,
      env: { ...process.env, ...instance.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    instance.children.add(child);
    const out = { stdout: "", stderr: "" };
    // Output names guest paths, as a real instance would: the instance's directory is left out.
    const guest = (data: Buffer) => data.toString().split(instance.root).join("");

    for (const stream of ["stdout", "stderr"] as const)
      child[stream].on("data", (data: Buffer) => {
        out[stream] += guest(data);
      });

    return new Promise((resolve) =>
      child.on("close", (code, signal) => {
        instance.children.delete(child);
        void rm(script, { force: true });
        resolve({
          exit_code: code ?? (signal === null ? 1 : 137),
          stdout: out.stdout,
          stderr: out.stderr,
          truncated: false,
        });
      }),
    );
  }

  async function exec(instance: FakeInstance, payload: Buffer, response: ServerResponse) {
    const input = execBody.parse(JSON.parse(payload.toString()));

    if (input.background) {
      void run(instance, input.command);

      return json(response, 200, { pid: 1 });
    }

    // Exec wakes a sleeping instance; a stopped one is down until a start.
    if (instance.status === "stopped") return failure(response, 502, "container_unavailable");
    instance.status = "running";
    const known = input.name === undefined ? undefined : runs.get(input.name);
    const answer = known ?? run(instance, input.command);

    if (input.name !== undefined) runs.set(input.name, answer);
    const done = await answer;

    if (stalls > 0) {
      stalls--;

      return failure(response, 504, "try_again");
    }

    return json(response, 200, done);
  }

  async function make(input: z.infer<typeof createBody>, from?: FakeInstance) {
    const instance: FakeInstance = {
      id: newId(),
      root: await mkdtemp(join(tmpdir(), "sdk-agent37-")),
      metadata: input.metadata ?? from?.metadata ?? {},
      env: from?.env ?? input.env ?? {},
      status: "running",
      created: Math.floor(Date.now() / 1000),
      children: new Set(),
    };

    if (from) await cp(from.root, instance.root, { recursive: true });
    await mkdir(join(instance.root, "tmp"), { recursive: true });
    instances.set(instance.id, instance);

    return instance;
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

    if (parts[1] === "exec") {
      if (request.headers["x-agent37-key"] !== "fake-key")
        return failure(response, 401, "invalid_api_key");
      const instance = instances.get(parts[4] ?? "");

      if (parts[2] !== "v1" || parts[3] !== "instances" || parts[5] !== "exec" || method !== "POST")
        return failure(response, 404, "not_found");

      if (!instance) return failure(response, 404, "not_found");

      return exec(instance, payload, response);
    }

    if (request.headers.authorization !== "Bearer fake-key")
      return failure(response, 401, "invalid_api_key");
    const [, version, collection, id, route] = parts;

    if (version !== "v1" || collection !== "instances") return failure(response, 404, "not_found");

    if (!id) {
      if (method === "GET") return json(response, 200, { data: [...instances.values()].map(info) });

      if (method !== "POST") return failure(response, 404, "not_found");

      return json(
        response,
        201,
        info(await make(createBody.parse(payload.length ? JSON.parse(payload.toString()) : {}))),
      );
    }

    const instance = instances.get(id);

    if (!instance) return failure(response, 404, "not_found");

    if (route === undefined && method === "GET") return json(response, 200, info(instance));

    if (route === undefined && method === "DELETE") {
      kill(instance);
      instances.delete(id);
      await rm(instance.root, { recursive: true, force: true });

      return json(response, 200, { id, deleted: true });
    }

    if (method === "POST" && route === "sleep") {
      if (instance.status !== "running" && instance.status !== "sleeping")
        return failure(response, 400, "invalid_request");
      instance.status = "sleeping";

      return json(response, 200, { id, status: instance.status });
    }

    if (method === "POST" && route === "start") {
      instance.status = "running";

      return json(response, 200, { id, status: instance.status });
    }

    if (method === "POST" && route === "stop") {
      kill(instance);
      instance.status = "stopped";

      return json(response, 200, { id, status: instance.status });
    }

    if (method === "POST" && route === "fork")
      return json(
        response,
        201,
        info(
          await make(
            createBody.parse(payload.length ? JSON.parse(payload.toString()) : {}),
            instance,
          ),
        ),
      );

    if (method === "POST" && route === "signed-url") {
      const { port } = z.object({ port: z.number() }).parse(JSON.parse(payload.toString()));

      return json(response, 201, {
        url: `https://${id}-${port}.agent37.app/?a37_token=a37tok_${newId()}`,
        domain_urls: [],
        port,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });
    }

    if (route === "public-ports" && method === "POST") {
      const { port } = z.object({ port: z.number() }).parse(JSON.parse(payload.toString()));

      return json(response, 201, { port, url: `https://${newId()}${newId()}.agent37.app` });
    }

    return failure(response, 404, "not_found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || isString(address)) throw new Error("The Agent 37 fake has no TCP port");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    url: origin,
    instances,
    requests,
    stallExec(count) {
      stalls = count;
    },
    async close() {
      for (const instance of instances.values()) kill(instance);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(
        [...instances.values()].map((i) => rm(i.root, { recursive: true, force: true })),
      );
    },
  };
}

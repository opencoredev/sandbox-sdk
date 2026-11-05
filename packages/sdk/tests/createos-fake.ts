/** Local HTTP fixture for CreateOS's JSend and managed-process protocols. Commands run in a temp directory. */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import type { JsonObject, JsonValue } from "../src/shared/json.js";
import { isJsonObject } from "../src/shared/json.js";
import { isString, isStringRecord } from "../src/shared/narrow.js";
import { fakeServer, type RecordedRequest } from "./http-fake.js";

export async function fakeCreateos() {
  const server = await fakeServer();
  const directory = await fs.mkdtemp(join(tmpdir(), "createos-test-"));
  await fs.mkdir(join(directory, "tmp"));
  const files = join(directory, "workspace");
  const env: Record<string, string> = {};
  let labels: Record<string, string> = {};
  let status = "running";
  let exists = false;
  let name = "test";
  let nextId = 0;

  const children = new Map<
    string,
    {
      child: ReturnType<typeof spawn>;
      frames: JsonObject[];
      listeners: Set<ServerResponse>;
      done: Promise<void>;
      exited: boolean;
      code: number | null;
    }
  >();

  const view = () => ({
    id: "sb-test",
    name,
    status,
    labels,
    created_at: "2026-01-01T00:00:00Z",
    ingress_enabled: true,
    ingress_url_template: "https://sb-test-<port>.example.com",
  });

  const send = (response: ServerResponse, data: JsonValue) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "success", data }));
  };

  const body = (request: RecordedRequest) => {
    const data: JsonValue = JSON.parse(request.body.toString() || "{}");

    if (!isJsonObject(data)) throw new Error("Expected a request object");

    return data;
  };

  const rewrite = (text: string) =>
    text.replace(/\/workspace|\/tmp\/\.sandbox-sdk[^ '";\n]*/g, (path) => join(directory, path));

  const proc = (id: string) => {
    const value = children.get(id);

    if (!value) throw new Error("No such fake process");

    return value;
  };

  const processView = (id: string) => ({
    process_id: id,
    pid: proc(id).child.pid ?? 1,
    tree_exited: proc(id).exited,
    exit_code: proc(id).code,
    signal: null,
  });

  const processId = (request: RecordedRequest) =>
    new URL(request.url, server.url).pathname.split("/")[5] ?? "";

  const root = "/v1/sandboxes/sb-test/processes";

  server.on("GET /v1/shapes", (_request, response) =>
    send(response, {
      data: [
        { id: "s-1vcpu-1gb", vcpu: 1, mem_mib: 1024 },
        { id: "s-2vcpu-2gb", vcpu: 2, mem_mib: 2048 },
        { id: "s-4vcpu-4gb", vcpu: 4, mem_mib: 4096 },
      ],
      pagination: { total: 3 },
    }),
  );
  server.on("POST /v1/sandboxes", (request, response) => {
    const data = body(request);
    labels = isStringRecord(data.labels) ? data.labels : {};
    name = isString(data.name) ? data.name : "test";
    Object.assign(env, isStringRecord(data.envs) ? data.envs : {});
    exists = true;
    send(response, { id: "sb-test" });
  });
  server.on("GET /v1/sandboxes", (_request, response) =>
    send(response, {
      data: exists ? [view()] : [],
      pagination: { total: exists ? 1 : 0 },
    }),
  );
  server.on("GET /v1/sandboxes/sb-test", (_request, response) => {
    if (!exists) {
      response.writeHead(404).end();

      return;
    }

    send(response, view());
  });
  server.on("DELETE /v1/sandboxes/sb-test", (_request, response) => {
    exists = false;
    send(response, { status: "destroyed" });
  });

  for (const operation of ["pause", "resume"])
    server.on(`POST /v1/sandboxes/sb-test/${operation}`, (_request, response) => {
      status = operation === "pause" ? "paused" : "running";
      send(response, view());
    });
  server.on(`POST ${root}`, (request, response) => {
    const data = body(request);

    if (!isString(data.cmd) || !Array.isArray(data.args) || !data.args.every(isString))
      throw new Error("Invalid fake command");
    const id = `p-${++nextId}`;

    const child = spawn(data.cmd, data.args.map(rewrite), {
      cwd: directory,
      detached: true,
      env: { PATH: process.env.PATH, ...env },
    });

    const listeners = new Set<ServerResponse>();
    const frames: JsonObject[] = [];
    let finish = () => {};

    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });

    children.set(id, { child, frames, listeners, done, exited: false, code: null });

    const emit = (frame: JsonObject) => {
      frames.push(frame);

      for (const listener of listeners) listener.write(JSON.stringify(frame) + "\n");
    };

    let seq = 0;

    for (const stream of ["stdout", "stderr"] as const)
      child[stream].on("data", (bytes: Buffer) =>
        emit({
          type: "data",
          seq: ++seq,
          stream,
          data_base64: bytes.toString("base64"),
        }),
      );
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      proc(id).exited = true;
      proc(id).code = code ?? 137;
      emit({ type: "exit", exit_code: code ?? 137 });

      for (const listener of listeners) listener.end();
      finish();
    });
    send(response, processView(id));
  });
  server.on(`POST ${root}/{processId}/input`, (request, response) => {
    const data = body(request);

    if (!isString(data.data_base64)) throw new Error("Invalid fake input");
    proc(processId(request)).child.stdin?.write(Buffer.from(data.data_base64, "base64"));
    send(response, { input_seq: 1 });
  });
  server.on(`POST ${root}/{processId}/stdin/close`, (request, response) => {
    proc(processId(request)).child.stdin?.end();
    send(response, { ok: true });
  });
  server.on(`GET ${root}/{processId}/connect`, (request, response) => {
    const child = proc(processId(request));
    const after = Number(new URL(request.url, server.url).searchParams.get("after"));
    response.writeHead(200, { "content-type": "application/x-ndjson" });

    for (const frame of child.frames)
      if (frame.type !== "data" || Number(frame.seq) > after)
        response.write(JSON.stringify(frame) + "\n");

    if (child.exited) {
      response.end();

      return;
    }

    child.listeners.add(response);
    response.on("close", () => child.listeners.delete(response));
  });
  server.on(`GET ${root}/{processId}/wait`, (request, response) =>
    send(response, processView(processId(request))),
  );
  server.on(`POST ${root}/{processId}/resize`, (_request, response) =>
    send(response, { ok: true }),
  );
  server.on(`DELETE ${root}/{processId}`, async (request, response) => {
    const id = processId(request);
    const child = proc(id);

    if (!child.exited && child.child.pid) {
      process.kill(-child.child.pid, "SIGKILL");
      await child.done;
    }

    send(response, processView(id));
  });

  for (const method of ["GET", "PUT"])
    server.on(`${method} /v1/sandboxes/sb-test/files`, async (request, response) => {
      const file = rewrite(new URL(request.url, server.url).searchParams.get("path") ?? "");

      try {
        if (method === "PUT") {
          await fs.writeFile(file, request.body);
          send(response, { ok: true });
        } else response.end(await fs.readFile(file));
      } catch {
        response.writeHead(404).end();
      }
    });

  return {
    server,
    directory,
    files,
    options: { apiKey: "createos-test-secret", baseUrl: server.url },
    async close() {
      for (const child of children.values())
        if (!child.exited && child.child.pid) {
          try {
            process.kill(-child.child.pid, "SIGKILL");
          } catch {}
        }

      await Promise.all([...children.values()].map((child) => child.done));
      await server.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

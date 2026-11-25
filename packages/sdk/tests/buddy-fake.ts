// A local stand-in for Buddy's Sandboxes API (https://buddy.works/openapi.json), for the adapter's tests and
// the no-peer consumer smoke. Each sandbox is a temporary directory; `/workspace`, `/buddy` and
// `/tmp/.sandbox-sdk` in commands and paths map into it, and commands run as real processes under bash.
// Only the routes the adapter uses are served, with Buddy's answers as checked live on 2026-11-24: create
// (unique identifiers, note, tags, encrypted variables, snapshot restore), read, list, delete, update
// (endpoints, with write-only passwords), stop, start, the synchronous `exec` (never listed), the
// recorded `execs` with long-polled status and a merged, line-split log, uploads, downloads (a directory
// comes back as a tar.gz) and snapshots. Tests can inject failures and cut logs.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { JsonObject, JsonValue } from "../src/shared/json.js";
import { isString } from "../src/shared/narrow.js";

export const fakeToken = "fake-buddy-token";
export const fakeWorkspace = "fake-ws";

export interface FakeEndpoint {
  name: string;
  endpoint: string;
  type: string;
  region: string;
  timeout: number;
  http: JsonObject;
  /** The stored BASIC password, never returned. */
  password?: string;
  /** Set when a PATCH sent back an `!encrypted` value as the password, which breaks the endpoint. */
  broken?: boolean;
  extra: JsonObject;
}

export interface FakeExec {
  id: string;
  sandboxId: string;
  command: string;
  status: "INPROGRESS" | "SUCCESSFUL" | "FAILED" | "CANCELLED";
  exitCode?: number;
  failureReason?: string;
  lines: string[];
  pending: string;
  startedAt: string;
  finishedAt?: string;
  child?: ChildProcess;
  waiters: Set<() => void>;
}

export interface FakeSandbox {
  id: string;
  identifier: string;
  name: string;
  project?: string;
  root: string;
  note?: string;
  tags: string[];
  variables: { key: string; value: string; encrypted: boolean; id: number }[];
  status: "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "FAILED";
  setupStatus: "INPROGRESS" | "SUCCESS" | "FAILED";
  resources: string;
  timeout?: number;
  createdAt: string;
  endpoints: FakeEndpoint[];
  children: Set<ChildProcess>;
  /** Execution IDs, oldest first. */
  execs: string[];
}

export interface FakeSnapshot {
  id: string;
  name: string;
  source: string;
  root: string;
  status: "CREATING" | "CREATED" | "FAILED";
}

/** A failure the fake answers one matching request with. */
export type FakeFault =
  /** Answer with this status and Buddy's `{ errors: [{ message }] }`, without applying the request. */
  | { kind: "status"; status: number; message: string }
  /** Apply the request, then drop the connection: the answer is lost. */
  | { kind: "lost" }
  /** Drop the connection without applying the request. */
  | { kind: "dropped" }
  /** Apply the request and answer `200` with this body instead of the real answer. */
  | { kind: "body"; body: JsonValue };

export interface FakeRule {
  method: string;
  /** Matched against the path after `/workspaces/<workspace>`, such as `/sandboxes` or `/sandboxes/x/execs`. */
  path: RegExp;
  fault: FakeFault;
  /** How many requests it applies to. Default: 1. */
  times?: number;
}

export interface BuddyFake {
  /** `http://127.0.0.1:<port>`, for `buddy({ baseUrl })`. */
  readonly url: string;
  readonly sandboxes: Map<string, FakeSandbox>;
  readonly snapshots: Map<string, FakeSnapshot>;
  readonly execs: Map<string, FakeExec>;
  /** Every request the fake answered: method, path with query, and the body it read. */
  readonly requests: { method: string; path: string; body: string }[];
  /** Faults applied to the next matching requests, in order. */
  readonly rules: FakeRule[];
  /** When set, an execution log serves at most this many lines, then reports `truncated`. */
  logLimit: number | undefined;
  /** When set, the log line with this index (from 0) is left out of every execution log, as a gap. */
  skipLogLine: number | undefined;
  /** How long a new or started sandbox stays `STARTING` / `INPROGRESS`. Default: 30 ms. */
  readyAfterMs: number;
  /** Options for the adapter that point it at this fake. */
  readonly options: { token: string; workspace: string; baseUrl: string };
  close(): Promise<void>;
}

const mapped = (sandbox: FakeSandbox, text: string) =>
  text.replace(/(?<![\w./-])(?:\/workspace|\/tmp\/\.sandbox-sdk|\/buddy)(?![\w.-])/g, (path) =>
    join(sandbox.root, path),
  );

/**
 * Maps paths inside the adapter's staged files too (`printf %s '<base64>' | base64 -d`), so an env file or
 * a long command names the sandbox's directory as a command line would. Binary data is left alone.
 */
const mappedCommand = (sandbox: FakeSandbox, text: string) =>
  mapped(
    sandbox,
    text.replace(/printf %s '([A-Za-z0-9+/=]*)' \| base64 -d/g, (whole, data: string) => {
      const bytes = Buffer.from(data, "base64");
      const decoded = bytes.toString("utf8");

      if (!Buffer.from(decoded).equals(bytes)) return whole;

      return `printf %s '${Buffer.from(mapped(sandbox, decoded)).toString("base64")}' | base64 -d`;
    }),
  );

/** Output names guest paths, as a real sandbox would: the sandbox's directory is left out, framed output too. */
function unmapped(sandbox: FakeSandbox, line: string) {
  const frame = /^(\d+:[OE]:)\d+:([A-Za-z0-9+/=]*)\.$/.exec(line);

  if (!frame) return line.split(sandbox.root).join("");

  const bytes = Buffer.from(frame[2] ?? "", "base64")
    .toString("latin1")
    .split(sandbox.root)
    .join("");

  const encoded = Buffer.from(bytes, "latin1").toString("base64");

  return `${frame[1]}${encoded.length}:${encoded}.`;
}

const createBody = z.looseObject({
  name: z.string().optional(),
  identifier: z.string().optional(),
  os: z.string().optional(),
  snapshot_id: z.string().optional(),
  resources: z.string().optional(),
  timeout: z.number().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  variables: z
    .array(
      z.looseObject({
        key: z.string(),
        value: z.string(),
        encrypted: z.boolean().optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
});

const commandBody = z.looseObject({ command: z.string(), runtime: z.string().optional() });

const endpointBody = z.looseObject({
  name: z.string(),
  endpoint: z.string(),
  type: z.string(),
  region: z.string().optional(),
  timeout: z.number().optional(),
  http: z.looseObject({}).optional(),
  tls: z.unknown().optional(),
});

const patchBody = z.looseObject({ endpoints: z.array(endpointBody).optional() });

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks);
}

const exists = (path: string) =>
  stat(path).then(
    (s) => (s.isDirectory() ? "directory" : "file"),
    () => undefined,
  );

const encrypted = () => `!encrypted ${Buffer.from(randomUUID()).toString("base64")}`;

export async function buddyFake(): Promise<BuddyFake> {
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, FakeSnapshot>();
  const execs = new Map<string, FakeExec>();
  const requests: BuddyFake["requests"] = [];
  const rules: FakeRule[] = [];
  let origin = "";
  let variableId = 1;
  const reserved = new Set<string>();

  function json(response: ServerResponse, status: number, value?: JsonValue): void {
    response
      .writeHead(status, value === undefined ? {} : { "content-type": "application/json" })
      .end(value === undefined ? undefined : JSON.stringify(value));
  }

  const failure = (response: ServerResponse, status: number, message: string): void =>
    json(response, status, { errors: [{ message }] });

  const base = () => `${origin}/workspaces/${fakeWorkspace}/sandboxes`;

  const endpointView = (sandbox: FakeSandbox, e: FakeEndpoint): JsonObject => ({
    ...e.extra,
    name: e.name,
    endpoint: e.endpoint,
    type: e.type,
    region: e.region,
    timeout: e.timeout,
    http: e.http,
    endpoint_url: `https://${e.name}-${sandbox.identifier}-${fakeWorkspace}.us-1.buddy.test`,
  });

  const view = (sandbox: FakeSandbox): JsonObject => {
    const out: JsonObject = {
      url: `${base()}/${sandbox.id}`,
      html_url: `https://app.buddy.test/${fakeWorkspace}/-/sandboxes/${sandbox.id}`,
      id: sandbox.id,
      identifier: sandbox.identifier,
      name: sandbox.name,
      status: sandbox.status,
      setup_status: sandbox.setupStatus,
      os: "ubuntu:24.04",
      resources: sandbox.resources,
      backup: "OFF",
      tags: sandbox.tags,
      endpoints: sandbox.endpoints.map((e) => endpointView(sandbox, e)),
      scope: sandbox.project ? "PROJECT" : "WORKSPACE",
      create_date: sandbox.createdAt,
      boot_logs: ["Sandbox starting...", "Sandbox started."],
      variables: sandbox.variables.map((v) => ({
        id: v.id,
        key: v.key,
        value: v.encrypted ? encrypted() : v.value,
        type: "VAR",
        encrypted: v.encrypted,
        disabled: false,
      })),
    };

    if (sandbox.note !== undefined) out.note = sandbox.note;

    if (sandbox.timeout !== undefined) out.timeout = sandbox.timeout;

    return out;
  };

  const summary = (sandbox: FakeSandbox): JsonObject => ({
    url: `${base()}/${sandbox.id}`,
    html_url: `https://app.buddy.test/${fakeWorkspace}/-/sandboxes/${sandbox.id}`,
    id: sandbox.id,
    identifier: sandbox.identifier,
    name: sandbox.name,
    status: sandbox.status,
    setup_status: sandbox.setupStatus,
  });

  const execView = (exec: FakeExec): JsonObject => {
    const out: JsonObject = {
      url: `${base()}/${exec.sandboxId}/execs/${exec.id}`,
      execution_id: exec.id,
      sandbox: exec.sandboxId,
      runtime: "BASH",
      type: "COMMAND",
      command: exec.command,
      started_at: exec.startedAt,
      status: exec.status,
      truncated: false,
      log_url: `${base()}/${exec.sandboxId}/execs/${exec.id}/log`,
    };

    if (exec.exitCode !== undefined) out.exit_code = exec.exitCode;

    if (exec.finishedAt !== undefined) out.finished_at = exec.finishedAt;

    if (exec.failureReason !== undefined) out.failure_reason = exec.failureReason;

    return out;
  };

  const snapshotView = (snapshot: FakeSnapshot): JsonObject => ({
    url: sandboxes.has(snapshot.source)
      ? `${base()}/${snapshot.source}/snapshots/${snapshot.id}`
      : `${base()}/snapshots/${snapshot.id}`,
    id: snapshot.id,
    name: snapshot.name,
    size: 1,
    status: snapshot.status,
    create_date: new Date().toISOString(),
    automatic: false,
  });

  function killAll(sandbox: FakeSandbox) {
    for (const child of sandbox.children)
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
  }

  function boot(sandbox: FakeSandbox) {
    sandbox.status = "STARTING";
    sandbox.setupStatus = "INPROGRESS";
    setTimeout(() => {
      if (sandbox.status !== "STARTING") return;
      sandbox.status = "RUNNING";
      sandbox.setupStatus = "SUCCESS";
    }, fake.readyAfterMs).unref();
  }

  const environment = (sandbox: FakeSandbox) => ({
    ...process.env,
    HOME: join(sandbox.root, "home"),
    ...Object.fromEntries(sandbox.variables.map((v) => [v.key, v.value])),
  });

  // Output names guest paths, as a real sandbox would: the sandbox's directory is left out.
  const guest = (sandbox: FakeSandbox, text: string) => text.split(sandbox.root).join("");

  function spawnCommand(sandbox: FakeSandbox, command: string) {
    const child = spawn("bash", ["-c", mappedCommand(sandbox, command)], {
      cwd: join(sandbox.root, "buddy"),
      env: environment(sandbox),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    sandbox.children.add(child);
    child.on("close", () => sandbox.children.delete(child));

    return child;
  }

  function runSync(sandbox: FakeSandbox, command: string) {
    const child = spawnCommand(sandbox, command);
    const out = { stdout: "", stderr: "" };

    for (const stream of ["stdout", "stderr"] as const)
      child[stream]?.on("data", (data: Buffer) => {
        out[stream] += guest(sandbox, data.toString());
      });

    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);

    return new Promise<JsonObject>((resolve) =>
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          command,
          runtime: "BASH",
          exit_code: code ?? (signal === "SIGKILL" ? 137 : 143),
          stdout: out.stdout,
          stderr: out.stderr,
        });
      }),
    );
  }

  function settle(exec: FakeExec) {
    for (const wake of exec.waiters) wake();
    exec.waiters.clear();
  }

  function runAsync(sandbox: FakeSandbox, command: string): FakeExec {
    const exec: FakeExec = {
      id: randomUUID(),
      sandboxId: sandbox.id,
      command,
      status: "INPROGRESS",
      lines: [],
      pending: "",
      startedAt: new Date().toISOString(),
      waiters: new Set(),
    };

    execs.set(exec.id, exec);
    sandbox.execs.push(exec.id);
    const child = spawnCommand(sandbox, command);
    exec.child = child;

    // Buddy merges both streams and splits them into lines, dropping `\r`.
    const take = (data: Buffer) => {
      exec.pending += data.toString();
      const parts = exec.pending.split("\n");
      exec.pending = parts.pop() ?? "";

      for (const part of parts) exec.lines.push(unmapped(sandbox, part.replace(/\r/g, "")));
    };

    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("close", (code) => {
      if (exec.pending) exec.lines.push(unmapped(sandbox, exec.pending.replace(/\r/g, "")));
      exec.pending = "";
      exec.finishedAt = new Date().toISOString();

      if (exec.status === "INPROGRESS") {
        exec.exitCode = code ?? 137;
        exec.status = exec.exitCode === 0 ? "SUCCESSFUL" : "FAILED";
      }

      settle(exec);
    });

    return exec;
  }

  async function makeSandbox(input: z.infer<typeof createBody>, project: string | undefined) {
    const id = `fk${randomUUID().replace(/-/g, "").slice(0, 11)}`;
    const identifier = input.identifier ?? id;

    const sandbox: FakeSandbox = {
      id,
      identifier,
      name: input.name ?? identifier,
      root: await mkdtemp(join(tmpdir(), "sdk-buddy-")),
      note: input.note,
      tags: input.tags ?? [],
      variables: (input.variables ?? []).map((v) => ({
        key: v.key,
        value: v.value,
        encrypted: v.encrypted === true,
        id: variableId++,
      })),
      status: "STARTING",
      setupStatus: "INPROGRESS",
      resources: input.resources ?? "2x4",
      createdAt: new Date().toISOString(),
      endpoints: [],
      children: new Set(),
      execs: [],
    };

    if (project !== undefined) sandbox.project = project;

    if (input.timeout !== undefined) sandbox.timeout = input.timeout;
    const snapshot = input.snapshot_id === undefined ? undefined : snapshots.get(input.snapshot_id);

    if (snapshot) await cp(snapshot.root, sandbox.root, { recursive: true });

    for (const dir of ["tmp", "buddy", "home"])
      await mkdir(join(sandbox.root, dir), { recursive: true });
    sandboxes.set(id, sandbox);
    boot(sandbox);

    return sandbox;
  }

  function applyEndpoints(sandbox: FakeSandbox, list: z.infer<typeof endpointBody>[]) {
    const next: FakeEndpoint[] = [];

    for (const input of list) {
      const prior = sandbox.endpoints.find((e) => e.name === input.name);
      const { password, ...httpRest } = input.http ?? {};
      const { name, endpoint, type, region, timeout, http: _http, ...extra } = input;

      const entry: FakeEndpoint = {
        name,
        endpoint,
        type,
        region: region ?? "US",
        timeout: timeout ?? 30,
        http: JSON.parse(JSON.stringify(httpRest)),
        extra: JSON.parse(JSON.stringify(extra)),
      };

      if (isString(password)) {
        if (password.startsWith("!encrypted")) entry.broken = true;
        else entry.password = password;
      } else if (prior?.password !== undefined) {
        entry.password = prior.password;
        entry.broken = prior.broken;
      }

      next.push(entry);
    }

    sandbox.endpoints = next;
  }

  async function download(sandbox: FakeSandbox, response: ServerResponse, path: string) {
    const target = mapped(sandbox, path);
    const kind = await exists(target);

    if (kind === undefined) return failure(response, 404, "File not found");

    if (kind === "file") {
      response
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${basename(path)}"`,
        })
        .end(await readFile(target));

      return;
    }

    const tar = spawn("tar", ["czf", "-", "-C", target, "."]);
    const chunks: Buffer[] = [];

    tar.stdout.on("data", (data: Buffer) => chunks.push(data));
    await new Promise((resolve) => tar.on("close", resolve));

    response
      .writeHead(200, {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${basename(path)}.tar.gz"`,
      })
      .end(Buffer.concat(chunks));
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    rest: string,
    payload: Buffer,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const parts = rest.split("/").filter(Boolean);
    // parts[0] === "sandboxes"
    const [, second, third, ...more] = parts;

    if (parts[0] !== "sandboxes") return failure(response, 404, "Resource not found");

    if (second === undefined) {
      const project = url.searchParams.get("project_name") ?? undefined;

      if (method === "GET")
        return json(response, 200, {
          url: base(),
          sandboxes: [...sandboxes.values()].flatMap((s) =>
            project === undefined || s.project === project ? [summary(s)] : [],
          ),
        });

      if (method === "POST") {
        const input = createBody.parse(JSON.parse(payload.toString()));

        // Checked and taken in one step, as Buddy does: two concurrent creates never both get it.
        if (
          input.identifier !== undefined &&
          (reserved.has(input.identifier) ||
            [...sandboxes.values()].some((s) => s.identifier === input.identifier))
        )
          return failure(response, 400, "'identifier' must be unique");

        if (input.resources === "CUSTOM") input.resources = "2x4";

        if (input.snapshot_id !== undefined && !snapshots.has(input.snapshot_id))
          return failure(response, 404, "Resource not found");

        if (input.identifier !== undefined) reserved.add(input.identifier);

        try {
          return json(response, 201, view(await makeSandbox(input, project)));
        } finally {
          if (input.identifier !== undefined) reserved.delete(input.identifier);
        }
      }

      return failure(response, 405, "Method not allowed");
    }

    if (second === "snapshots") {
      if (third === undefined && method === "GET")
        return json(response, 200, { snapshots: [...snapshots.values()].map(snapshotView) });
      const snapshot = third === undefined ? undefined : snapshots.get(third);

      if (!snapshot) return failure(response, 404, "Resource not found");

      if (method === "DELETE") {
        snapshots.delete(snapshot.id);
        await rm(snapshot.root, { recursive: true, force: true });

        return json(response, 204);
      }

      return failure(response, 405, "Method not allowed");
    }

    const sandbox = sandboxes.get(second);

    if (!sandbox) return failure(response, 404, "Resource not found");

    if (third === undefined) {
      if (method === "GET") return json(response, 200, view(sandbox));

      if (method === "DELETE") {
        killAll(sandbox);
        sandboxes.delete(sandbox.id);
        await rm(sandbox.root, { recursive: true, force: true });

        return json(response, 204);
      }

      if (method === "PATCH") {
        const input = patchBody.parse(JSON.parse(payload.toString()));

        if (input.endpoints) applyEndpoints(sandbox, input.endpoints);

        return json(response, 200, view(sandbox));
      }

      return failure(response, 405, "Method not allowed");
    }

    if (third === "stop" && method === "POST") {
      if (sandbox.status !== "RUNNING") return failure(response, 403, "Sandbox must be running");
      killAll(sandbox);
      sandbox.status = "STOPPING";
      setTimeout(() => {
        sandbox.status = "STOPPED";
      }, 20).unref();

      return json(response, 200, view(sandbox));
    }

    if (third === "start" && method === "POST") {
      if (sandbox.status === "STOPPED") boot(sandbox);

      return json(response, 200, view(sandbox));
    }

    if (third === "snapshots") {
      const id = more[0];

      if (id === undefined && method === "GET")
        return json(response, 200, {
          snapshots: [...snapshots.values()].flatMap((s) =>
            s.source === sandbox.id ? [snapshotView(s)] : [],
          ),
        });

      if (id === undefined && method === "POST") {
        const { name } = z.object({ name: z.string() }).parse(JSON.parse(payload.toString()));
        const root = await mkdtemp(join(tmpdir(), "sdk-buddy-snap-"));
        await cp(sandbox.root, root, { recursive: true });

        const snapshot: FakeSnapshot = {
          id: `sn${randomUUID().replace(/-/g, "").slice(0, 10)}`,
          name,
          source: sandbox.id,
          root,
          status: "CREATING",
        };

        snapshots.set(snapshot.id, snapshot);

        return json(response, 200, snapshotView(snapshot));
      }

      const snapshot = id === undefined ? undefined : snapshots.get(id);

      if (!snapshot || snapshot.source !== sandbox.id)
        return failure(response, 404, "Resource not found");

      if (method === "GET") {
        const answer = snapshotView(snapshot);
        snapshot.status = "CREATED";

        return json(response, 200, answer);
      }

      return failure(response, 405, "Method not allowed");
    }

    const running = sandbox.status === "RUNNING";

    if (third === "exec" && method === "POST") {
      if (!running) return failure(response, 400, "Sandbox must be running");
      const { command } = commandBody.parse(JSON.parse(payload.toString()));

      if (Buffer.byteLength(command) > 128 * 1024)
        return failure(
          response,
          400,
          "Error executing sandbox command: http: request body too large",
        );

      return json(response, 200, await runSync(sandbox, command));
    }

    if (third === "execs") {
      const id = more[0];

      if (id === undefined && method === "POST") {
        if (!running) return failure(response, 403, "Sandbox must be running");
        const { command } = commandBody.parse(JSON.parse(payload.toString()));

        if (Buffer.byteLength(command) > 16_384)
          return failure(response, 400, "Value of 'command' is too long (max 16,384 bytes)");

        return json(response, 200, execView(runAsync(sandbox, command)));
      }

      if (id === undefined && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 50);

        return json(
          response,
          200,
          sandbox.execs
            .slice()
            .reverse()
            .slice(0, limit)
            .flatMap((e) => {
              const exec = execs.get(e);

              return exec ? [execView(exec)] : [];
            }),
        );
      }

      const exec = id === undefined ? undefined : execs.get(id);

      if (!exec || exec.sandboxId !== sandbox.id)
        return failure(response, 404, "Resource not found");

      if (more[1] === "log" && method === "GET") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 1000);
        let lines = exec.lines.filter((_, index) => index !== fake.skipLogLine);
        let truncated = false;

        if (fake.logLimit !== undefined && lines.length > fake.logLimit) {
          lines = lines.slice(0, fake.logLimit);
          truncated = true;
        }

        const slice = lines.slice(offset, offset + limit);

        return json(response, 200, {
          execution_id: exec.id,
          lines: slice,
          next_offset: offset + slice.length,
          truncated,
        });
      }

      if (more[1] === undefined && method === "GET") {
        const wait = Number(url.searchParams.get("wait") ?? 25_000);

        const waiters = exec.waiters;

        if (exec.status === "INPROGRESS" && wait > 0)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, Math.min(wait, 25_000));

            function done() {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            }

            waiters.add(done);
          });

        return json(response, 200, execView(exec));
      }

      if (more[1] === undefined && method === "DELETE") {
        if (exec.status === "INPROGRESS") {
          exec.status = "CANCELLED";

          exec.finishedAt = new Date().toISOString();

          try {
            if (exec.child?.pid !== undefined) process.kill(-exec.child.pid, "SIGKILL");
          } catch {
            exec.child?.kill("SIGKILL");
          }

          settle(exec);
        }

        return json(response, 204);
      }

      return failure(response, 405, "Method not allowed");
    }

    if (third === "download" && method === "GET") {
      if (!running) return failure(response, 400, "Sandbox must be running");

      return download(sandbox, response, `/${more.map(decodeURIComponent).join("/")}`);
    }

    if (third === "content" && more[0] === "upload" && method === "POST") {
      if (!running) return failure(response, 400, "Sandbox must be running");
      const path = `/${more.slice(1).map(decodeURIComponent).join("/")}`;
      const headers = new Headers();

      for (const [key, value] of Object.entries(request.headers))
        if (isString(value)) headers.set(key, value);

      const form = await new Request("http://fake/upload", {
        method: "POST",
        headers,
        body: new Uint8Array(payload),
      }).formData();

      const file = form.get("file");

      if (!(file instanceof Blob)) return failure(response, 400, "file is required");
      const target = mapped(sandbox, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(await file.arrayBuffer()));

      return json(response, 201, { type: "FILE", name: basename(path), path, size: file.size });
    }

    return failure(response, 404, "Resource not found");
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake");
    const payload = await body(request);
    const method = request.method ?? "GET";

    requests.push({ method, path: `${url.pathname}${url.search}`, body: payload.toString() });

    if (request.headers.authorization !== `Bearer ${fakeToken}`)
      return failure(response, 401, "Unauthorized");
    const prefix = `/workspaces/${fakeWorkspace}`;

    if (!url.pathname.startsWith(`${prefix}/`)) return failure(response, 404, "Resource not found");
    const rest = url.pathname.slice(prefix.length);
    const rule = rules.find((r) => r.method === method && r.path.test(rest));

    if (rule) {
      rule.times = (rule.times ?? 1) - 1;

      if (rule.times <= 0) rules.splice(rules.indexOf(rule), 1);

      switch (rule.fault.kind) {
        case "status":
          return failure(response, rule.fault.status, rule.fault.message);
        case "dropped":
          response.destroy();

          return;
        case "lost": {
          const sink = new FakeSink();
          await route(request, sink.response(response), url, rest, payload);
          response.destroy();

          return;
        }

        case "body": {
          const sink = new FakeSink();
          await route(request, sink.response(response), url, rest, payload);

          return json(response, 200, rule.fault.body);
        }

        default: {
          const exhaustive: never = rule.fault;

          return exhaustive;
        }
      }
    }

    try {
      await route(request, response, url, rest, payload);
    } catch (error) {
      if (!response.headersSent)
        failure(response, 500, error instanceof Error ? error.message : "internal error");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || isString(address)) throw new Error("The Buddy fake has no TCP port");
  origin = `http://127.0.0.1:${address.port}`;

  const fake: BuddyFake = {
    url: origin,
    sandboxes,
    snapshots,
    execs,
    requests,
    rules,
    logLimit: undefined,
    skipLogLine: undefined,
    readyAfterMs: 30,
    options: { token: fakeToken, workspace: fakeWorkspace, baseUrl: origin },
    async close() {
      for (const sandbox of sandboxes.values()) killAll(sandbox);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(
        [...sandboxes.values(), ...snapshots.values()].map((s) =>
          rm(s.root, { recursive: true, force: true }),
        ),
      );
    },
  };

  return fake;
}

/** A response that swallows what the route writes, for faults that apply a request but lose its answer. */
class FakeSink {
  response(real: ServerResponse): ServerResponse {
    const sink: ServerResponse = Object.create(real);
    const swallow = () => sink;

    Object.defineProperties(sink, {
      headersSent: { value: false },
      writeHead: { value: swallow },
      write: { value: () => true },
      end: { value: swallow },
    });

    return sink;
  }
}

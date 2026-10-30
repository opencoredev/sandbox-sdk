/** A local E2B: the control plane and envd over HTTP, backed by isolated Linux directories and real processes.
 * It speaks what the adapter speaks on the wire: REST JSON with `X-API-KEY`, envd `/files`, and Connect JSON
 * (unary and server-stream envelopes) with `X-Access-Token` and the `E2b-Sandbox-Id` routing header. Like envd,
 * SendSignal targets ONE pid; adapter group kills must stop descendants.
 *
 *   const e2b = await fakeE2B();
 *   vi.stubGlobal("fetch", e2b.fetch(globalThis.fetch));   // routes api.*, sandbox.*, 49983-* and 3000-* hosts here
 */
import type { JsonObject, JsonValue } from "../src/shared/json.js";
import { isBoolean, isNumber, isObject, isString } from "../src/shared/narrow.js";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ServerResponse } from "node:http";
import { connectEnvelope } from "../src/streams.js";
import { fakeServer, type FakeServer, type RecordedRequest } from "./http-fake.js";
import { guestInputVariable, mapGuestInput } from "./guest-input.js";

export interface CreateCall {
  template: string;
  body: JsonObject;
  host: string;
}

export interface ListQuery {
  metadata: Record<string, string>;
  state: string[];
}

export interface Info {
  sandboxID: string;
  templateID: string;
  metadata: Record<string, string>;
  startedAt: string;
  endAt: string;
  state: "running" | "paused";
  envdVersion: string;
  cpuCount: number;
  memoryMB: number;
  allowInternetAccess?: boolean;
  network?: { allowOut?: string[]; denyOut?: string[]; allowPublicTraffic?: boolean };
}

/** Spawns the script the adapter sent (after path rewriting); a start hook may change it or run others first. */
export type Spawn = (script: string) => Promise<FakeProcess>;

export type StartHook = (script: string, spawn: Spawn, machine: Machine) => Promise<FakeProcess>;

type Message = JsonObject;

/** Any value JSON.stringify accepts. */
type Serializable = Parameters<typeof JSON.stringify>[0];

const json = (response: ServerResponse, status: number, body: Serializable) => {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parse(body: Buffer): Message {
  const value: unknown = body.length ? JSON.parse(body.toString()) : {};

  if (!isRecord(value)) throw new Error("fake e2b: body is not an object");

  return value;
}

function unenvelope(body: Buffer): Message {
  if (body.length < 5 || body[0] !== 0)
    throw new Error("fake e2b: request is not one Connect envelope");

  return parse(body.subarray(5, 5 + body.readUInt32BE(1)));
}

export class FakeProcess {
  readonly pid: number;
  /** Every event after start, for the Start stream that may attach late; Connect streams see only new ones. */
  readonly log: Message[] = [];
  readonly listeners = new Set<(message: Message) => void>();
  done = false;
  /** Stdin of a guest file command, held until CloseStdin so its JSON paths can be mapped. */
  guestStdin?: Buffer[];
  readonly exited: Promise<void>;
  constructor(
    readonly child: ChildProcess,
    readonly tag: string | undefined,
    readonly args: string[],
    machine: Machine,
    fragment: () => "chars" | "split3" | undefined,
  ) {
    if (!child.pid) throw new Error("fake e2b: command did not start");
    this.pid = child.pid;

    const push = (message: Message) => {
      this.log.push(message);

      for (const listener of this.listeners) listener(message);
    };

    for (const stream of ["stdout", "stderr"] as const) {
      const decoder = new StringDecoder("utf8");
      child[stream]?.on("data", (data: Buffer) => {
        const text = decoder.write(data).split(machine.root).join("");

        if (!text) return;
        const mode = fragment();

        const parts =
          mode === "chars"
            ? [...text]
            : mode === "split3"
              ? [text.slice(0, 3), text.slice(3)].filter(Boolean)
              : [text];

        for (const part of parts)
          push({ event: { data: { [stream]: Buffer.from(part).toString("base64") } } });
      });
    }

    this.exited = new Promise((resolve) =>
      child.on("close", (code, signal) => {
        // proto3 JSON leaves the default out: a clean exit has no exitCode. A signal death is -1, not exited.
        const end = signal
          ? { exitCode: -1, exited: false, status: `signal: ${signal}` }
          : code === 0
            ? { exited: true, status: "exit status 0" }
            : { exitCode: code, exited: true, status: `exit status ${code}` };

        this.done = true;
        push({ event: { end } });
        resolve();
      }),
    );
    child.stdin?.on("error", () => {});
  }
}

export class Machine {
  readonly processes = new Map<number, FakeProcess>();
  readonly sandboxId = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  readonly accessToken = `envd-${crypto.randomUUID()}`;
  readonly trafficToken?: string;
  timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly root: string,
    readonly info: Info,
    readonly port: number,
    readonly env: Record<string, string>,
  ) {
    if (info.network?.allowPublicTraffic === false) this.trafficToken = `traffic-${this.sandboxId}`;
  }
  mapped = (path: string) => join(this.root, path);
  rewrite = (command: string) =>
    command
      .replace(/\/workspace|\/tmp\/\.sandbox-sdk[^\s'";)]*|\/tmp\/sdk-bare/g, (path) =>
        this.mapped(path),
      )
      .replace(/\.listen\(3000,/g, `.listen(${this.port},`);
}

export interface FakeE2B {
  readonly server: FakeServer;
  readonly machines: Map<string, Machine>;
  readonly calls: CreateCall[];
  readonly listQueries: ListQuery[];
  /** Pids SendSignal killed with SIGKILL. */
  readonly nativeKills: number[];
  /** Pids process Connect reattached to. */
  readonly reconnects: number[];
  /** The scripts every Start carried, before rewriting. */
  readonly starts: string[];
  /** The domain create and connect report. `e2b.test` routes envd to `49983-{id}.e2b.test`; `e2b.app` to the shared host. */
  sandboxDomain: string;
  envdVersion: string;
  createDelayMs: number;
  /** Delay the start event after spawning, as a slow envd answer. */
  startDelayMs: number;
  /** Split each output chunk into one data event per character, or after its third character. */
  fragment?: "chars" | "split3";
  /** Spawn new commands as process group leaders, as some envd builds do. */
  launchGroupLeader: boolean;
  startHook?: StartHook;
  /** Rewrite the next `GET /sandboxes/{id}` answer. */
  infoOnce?: (info: Info) => Info;
  /** Requests whose `METHOD path` matches (`{id}` segments allowed). */
  count(route: string): number;
  pause(id: string): void;
  kill(id: string): Promise<boolean>;
  fetch(original: typeof fetch): typeof fetch;
  close(): Promise<void>;
}

export async function fakeE2B(): Promise<FakeE2B> {
  const server = await fakeServer();
  const machines = new Map<string, Machine>();
  const snapshots = new Map<string, string>();

  const calls: CreateCall[] = [],
    listQueries: ListQuery[] = [],
    nativeKills: number[] = [],
    reconnects: number[] = [],
    starts: string[] = [];

  const connectionOf = (machine: Machine) => ({
    sandboxID: machine.sandboxId,
    templateID: machine.info.templateID,
    envdVersion: machine.info.envdVersion,
    envdAccessToken: machine.accessToken,
    trafficAccessToken: machine.trafficToken || undefined,
    domain: fake.sandboxDomain,
  });

  function setTimer(machine: Machine, seconds: number) {
    clearTimeout(machine.timer);
    machine.info.endAt = new Date(Date.now() + seconds * 1000).toISOString();
    machine.timer = setTimeout(() => {
      void kill(machine.sandboxId);
    }, seconds * 1000);
    machine.timer.unref();
  }

  async function kill(id: string) {
    const machine = machines.get(id);

    if (!machine) return false;
    machines.delete(id);
    clearTimeout(machine.timer);

    for (const proc of machine.processes.values()) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}

      proc.child.kill("SIGKILL");
    }

    await fs.rm(machine.root, { recursive: true, force: true });

    return true;
  }

  const authorized = (request: RecordedRequest) =>
    request.headers["x-api-key"] === "mock" || request.headers["x-api-key"] === "valid";

  /** The control plane: a missing or wrong key is 401, whose message must never reach a SandboxError. */
  function control(
    handler: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>,
  ) {
    return async (request: RecordedRequest, response: ServerResponse) => {
      if (!authorized(request)) {
        json(response, 401, { code: 401, message: "secret-key-do-not-leak" });

        return;
      }

      await handler(request, response);
    };
  }

  const idOf = (request: RecordedRequest) =>
    request.url.split("?")[0]!.split("/").filter(Boolean)[request.url.startsWith("/v2/") ? 2 : 1] ??
    "";

  /** envd behind the proxy: a gone sandbox is the proxy's 502, a wrong token envd's 401. */
  function envd(
    handler: (
      machine: Machine,
      request: RecordedRequest,
      response: ServerResponse,
    ) => void | Promise<void>,
  ) {
    return async (request: RecordedRequest, response: ServerResponse) => {
      const header = request.headers["e2b-sandbox-id"];
      const machine = isString(header) ? machines.get(header) : undefined;

      if (!machine || machine.info.state === "paused") {
        response.writeHead(502, { "content-type": "text/plain" }).end("The sandbox was not found");

        return;
      }

      if (request.headers["x-access-token"] !== machine.accessToken) {
        json(response, 401, { code: "unauthenticated", message: "invalid access token" });

        return;
      }

      await handler(machine, request, response);
    };
  }

  async function entry(machine: Machine, path: string) {
    const stat = await fs.lstat(machine.mapped(path));

    return {
      name: posix.basename(path),
      path,
      type: stat.isDirectory()
        ? "FILE_TYPE_DIRECTORY"
        : stat.isSymbolicLink()
          ? "FILE_TYPE_SYMLINK"
          : "FILE_TYPE_FILE",
      size: String(stat.size),
      modifiedTime: stat.mtime.toISOString(),
      mode: stat.mode,
      permissions: "rwx",
      owner: "root",
      group: "root",
    };
  }

  const notFound = (response: ServerResponse, what: string) =>
    json(response, 404, { code: "not_found", message: `${what} not found` });

  function spawnIn(machine: Machine, message: Message): Spawn {
    const config = isRecord(message.process) ? message.process : {};

    const envs = isRecord(config.envs)
      ? Object.fromEntries(Object.entries(config.envs).map(([key, value]) => [key, String(value)]))
      : {};

    const cwd = isString(config.cwd) ? config.cwd : "/";
    const tag = isString(message.tag) ? message.tag : undefined;

    return async (script) => {
      const env = { ...process.env, ...machine.env, ...envs };

      for (const name of ["GIT_INDEX_FILE", "BASH_ENV"]) {
        const value = env[name];

        if (value) env[name] = machine.rewrite(value);
      }

      const guest = env[guestInputVariable] !== undefined;

      if (env[guestInputVariable])
        env[guestInputVariable] = mapGuestInput(env[guestInputVariable], machine.mapped);

      const child = spawn("/bin/bash", ["-l", "-c", machine.rewrite(script)], {
        cwd: machine.mapped(cwd),
        env,
        detached: fake.launchGroupLeader,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const proc = new FakeProcess(child, tag, ["-l", "-c", script], machine, () => fake.fragment);
      machine.processes.set(proc.pid, proc);

      if (guest) proc.guestStdin = [];

      if (message.stdin !== true) child.stdin?.end();

      return proc;
    };
  }

  /** Writes a Connect stream: the start event, then events (replayed from `from`), then the end frame. */
  async function stream(
    proc: FakeProcess,
    response: ServerResponse,
    from: number,
    deadlineMs: number,
  ) {
    response.writeHead(200, { "content-type": "application/connect+json" });
    response.write(connectEnvelope({ event: { start: { pid: proc.pid } } }));
    let finish = () => {};

    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    let deadline: ReturnType<typeof setTimeout> | undefined;

    const write = (message: Message) => {
      if (response.destroyed) return;
      response.write(connectEnvelope(message));

      if (isRecord(message.event) && "end" in message.event) finish();
    };

    for (const message of proc.log.slice(from)) write(message);
    proc.listeners.add(write);
    response.on("close", () => {
      proc.listeners.delete(write);
      finish();
    });

    if (deadlineMs > 0 && !proc.done)
      deadline = setTimeout(() => {
        proc.child.kill("SIGKILL");
        response.end(
          connectEnvelope(
            { error: { code: "deadline_exceeded", message: "deadline exceeded" } },
            true,
          ),
        );
        finish();
      }, deadlineMs);

    if (proc.done) finish();
    await finished;
    clearTimeout(deadline);
    proc.listeners.delete(write);

    if (!response.destroyed && !response.writableEnded) response.end(connectEnvelope({}, true));
  }

  const target = (machine: Machine, message: Message) => {
    const selector = isRecord(message.process) ? message.process : {};

    if (isNumber(selector.pid)) return machine.processes.get(selector.pid);

    return [...machine.processes.values()].find(
      (proc) => !proc.done && proc.tag !== undefined && proc.tag === selector.tag,
    );
  };

  server
    .on(
      "POST /v2/sandboxes",
      control(async (request, response) => {
        const body = parse(request.body);
        const template = isString(body.templateID) ? body.templateID : "base";
        calls.push({ template, body, host: String(request.headers["x-fake-host"] ?? "") });

        if (fake.createDelayMs) await sleep(fake.createDelayMs);

        const port = await new Promise<number>((resolve, reject) => {
          const probe = createServer();
          probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            probe.close(() =>
              isObject(address) && address ? resolve(address.port) : reject(new Error("no port")),
            );
          });
        });

        const root = await fs.mkdtemp(join(tmpdir(), "sdk-e2b-"));
        await fs.mkdir(join(root, "tmp"));
        const snapshot = snapshots.get(template);

        if (snapshot) await fs.cp(snapshot, root, { recursive: true });
        const network = isRecord(body.network) ? body.network : undefined;

        const list = (value: JsonValue | undefined) =>
          Array.isArray(value) ? value.map(String) : undefined;

        const info: Info = {
          sandboxID: "",
          templateID: template,
          metadata: isRecord(body.metadata)
            ? Object.fromEntries(
                Object.entries(body.metadata).map(([key, value]) => [key, String(value)]),
              )
            : {},
          startedAt: new Date().toISOString(),
          endAt: "",
          state: "running",
          envdVersion: fake.envdVersion,
          cpuCount: 2,
          memoryMB: 512,
          allowInternetAccess: isBoolean(body.allow_internet_access)
            ? body.allow_internet_access
            : undefined,
          network: network
            ? {
                allowOut: list(network.allowOut),
                denyOut: list(network.denyOut),
                allowPublicTraffic: isBoolean(network.allowPublicTraffic)
                  ? network.allowPublicTraffic
                  : undefined,
              }
            : undefined,
        };

        const env = isRecord(body.envVars)
          ? Object.fromEntries(
              Object.entries(body.envVars).map(([key, value]) => [key, String(value)]),
            )
          : {};

        const machine = new Machine(root, info, port, env);
        info.sandboxID = machine.sandboxId;
        machines.set(machine.sandboxId, machine);
        setTimer(machine, isNumber(body.timeout) ? body.timeout : 300);
        json(response, 201, connectionOf(machine));
      }),
    )
    .on(
      "GET /v2/sandboxes",
      control((request, response) => {
        const query = new URL(request.url, "http://fake").searchParams;

        const metadata = Object.fromEntries(
          [...new URLSearchParams(query.get("metadata") ?? "")].map(([key, value]) => [
            decodeURIComponent(key),
            decodeURIComponent(value),
          ]),
        );

        const state = (query.get("state") ?? "running,paused").split(",");
        listQueries.push({ metadata, state });

        const found = [...machines.values()].filter(
          (machine) =>
            state.includes(machine.info.state) &&
            Object.entries(metadata).every(([key, value]) => machine.info.metadata[key] === value),
        );

        // An empty first page, then one item per page, to exercise pagination.
        const page = Number(query.get("nextToken") ?? "0");
        const items = page === 0 ? [] : found.slice(page - 1, page);
        const headers = { "content-type": "application/json" };
        response
          .writeHead(
            200,
            page < found.length ? { ...headers, "x-next-token": String(page + 1) } : headers,
          )
          .end(
            JSON.stringify(
              items.map((machine) => ({ ...machine.info, metadata: { ...machine.info.metadata } })),
            ),
          );
      }),
    )
    .on(
      "GET /sandboxes/{id}",
      control((request, response) => {
        const machine = machines.get(idOf(request));

        if (!machine) {
          json(response, 404, { code: 404, message: "sandbox not found" });

          return;
        }

        const info = { ...machine.info, metadata: { ...machine.info.metadata } };
        const rewrite = fake.infoOnce;
        fake.infoOnce = undefined;
        json(response, 200, rewrite ? rewrite(info) : info);
      }),
    )
    .on(
      "DELETE /sandboxes/{id}",
      control(async (request, response) => {
        if (await kill(idOf(request))) response.writeHead(204).end();
        else json(response, 404, { code: 404, message: "sandbox not found" });
      }),
    )
    .on(
      "POST /v2/sandboxes/{id}/connect",
      control((request, response) => {
        const machine = machines.get(idOf(request));

        if (!machine) {
          json(response, 404, { code: 404, message: "sandbox not found" });

          return;
        }

        const body = parse(request.body);
        machine.info.state = "running";

        if (isNumber(body.timeout)) setTimer(machine, body.timeout);
        json(response, 200, connectionOf(machine));
      }),
    )
    .on(
      "POST /sandboxes/{id}/timeout",
      control((request, response) => {
        const machine = machines.get(idOf(request));

        if (!machine) {
          json(response, 404, { code: 404, message: "sandbox not found" });

          return;
        }

        const body = parse(request.body);
        setTimer(machine, isNumber(body.timeout) ? body.timeout : 300);
        response.writeHead(204).end();
      }),
    )
    .on(
      "POST /sandboxes/{id}/pause",
      control((request, response) => {
        const machine = machines.get(idOf(request));

        if (!machine) {
          json(response, 404, { code: 404, message: "sandbox not found" });

          return;
        }

        if (machine.info.state === "paused") {
          json(response, 409, { code: 409, message: "already paused" });

          return;
        }

        fake.pause(machine.sandboxId);
        response.writeHead(204).end();
      }),
    )
    .on(
      "POST /sandboxes/{id}/snapshots",
      control(async (request, response) => {
        const machine = machines.get(idOf(request));

        if (!machine) {
          json(response, 404, { code: 404, message: "sandbox not found" });

          return;
        }

        const id = `snap-${crypto.randomUUID()}`;
        const path = await fs.mkdtemp(join(tmpdir(), "sdk-e2b-snapshot-"));
        await fs.cp(machine.root, path, { recursive: true });
        snapshots.set(id, path);
        json(response, 201, { snapshotID: id, names: [`${id}:default`] });
      }),
    )
    .on(
      "GET /health",
      envd((_machine, _request, response) => {
        response.writeHead(204).end();
      }),
    )
    .on(
      "GET /files",
      envd(async (machine, request, response) => {
        const path = new URL(request.url, "http://fake").searchParams.get("path") ?? "";

        try {
          const data = await fs.readFile(machine.mapped(path));
          response.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
        } catch {
          json(response, 404, { code: 404, message: "file not found" });
        }
      }),
    )
    .on(
      "POST /files",
      envd(async (machine, request, response) => {
        const single = new URL(request.url, "http://fake").searchParams.get("path");

        const form = await new Response(new Uint8Array(request.body), {
          headers: { "content-type": String(request.headers["content-type"]) },
        }).formData();

        const written: unknown[] = [];

        for (const value of form.getAll("file")) {
          if (isString(value)) throw new Error("fake e2b: file field is not a file");
          const path = single ?? value.name;
          await fs.mkdir(posix.dirname(machine.mapped(path)), { recursive: true });
          await fs.writeFile(machine.mapped(path), new Uint8Array(await value.arrayBuffer()));
          written.push({ name: posix.basename(path), type: "file", path });
        }

        json(response, 200, written);
      }),
    )
    .on(
      "POST /filesystem.Filesystem/{method}",
      envd(async (machine, request, response) => {
        const method = request.url.split("/").at(-1);
        const { path } = parse(request.body);

        if (!isString(path)) {
          json(response, 400, { code: "invalid_argument", message: "path is required" });

          return;
        }

        const exists = await fs.lstat(machine.mapped(path)).then(
          () => true,
          () => false,
        );

        if (method === "MakeDir") {
          if (exists) {
            json(response, 409, { code: "already_exists", message: "directory exists" });

            return;
          }

          await fs.mkdir(machine.mapped(path), { recursive: true });
          json(response, 200, { entry: await entry(machine, path) });

          return;
        }

        if (!exists) {
          notFound(response, "path");

          return;
        }

        if (method === "Stat") json(response, 200, { entry: await entry(machine, path) });
        else if (method === "ListDir") {
          const entries = await Promise.all(
            (await fs.readdir(machine.mapped(path))).map((name) =>
              entry(machine, posix.join(path, name)),
            ),
          );

          // proto3 JSON leaves an empty repeated field out.
          json(response, 200, entries.length ? { entries } : {});
        } else if (method === "Remove") {
          await fs.rm(machine.mapped(path), { recursive: true });
          json(response, 200, {});
        } else json(response, 404, { code: "unimplemented", message: "no such method" });
      }),
    )
    .on(
      "POST /process.Process/{method}",
      envd(async (machine, request, response) => {
        const method = request.url.split("/").at(-1);
        const deadline = Number(request.headers["connect-timeout-ms"] ?? 0);

        if (method === "Start") {
          const message = unenvelope(request.body);
          const config = isRecord(message.process) ? message.process : {};
          const script = Array.isArray(config.args) ? String(config.args[2]) : "";
          starts.push(script);
          const run = spawnIn(machine, message);
          let proc: FakeProcess;

          try {
            proc = fake.startHook ? await fake.startHook(script, run, machine) : await run(script);
          } catch (error) {
            json(response, 500, {
              code: "internal",
              message: `fake start hook failed: ${String(error)}`,
            });

            return;
          }

          if (fake.startDelayMs) await sleep(fake.startDelayMs);
          await stream(proc, response, 0, deadline);

          return;
        }

        if (method === "Connect") {
          const proc = target(machine, unenvelope(request.body));

          if (!proc) {
            response
              .writeHead(200, { "content-type": "application/connect+json" })
              .end(
                connectEnvelope(
                  { error: { code: "not_found", message: "process not found" } },
                  true,
                ),
              );

            return;
          }

          reconnects.push(proc.pid);
          // envd does not replay output; an exited process still reports its end, as the SDK mock did.
          await stream(proc, response, proc.done ? proc.log.length - 1 : proc.log.length, deadline);

          return;
        }

        const message = parse(request.body);

        if (method === "List") {
          json(response, 200, {
            processes: [...machine.processes.values()].flatMap((proc) =>
              proc.done
                ? []
                : [
                    {
                      pid: proc.pid,
                      tag: proc.tag || undefined,
                      config: { cmd: "/bin/bash", args: proc.args },
                    },
                  ],
            ),
          });

          return;
        }

        const proc = target(machine, message);

        if (!proc || proc.done) {
          notFound(response, "process");

          return;
        }

        if (method === "SendSignal") {
          if (message.signal === "SIGNAL_SIGKILL" || message.signal === 9) {
            nativeKills.push(proc.pid);
            proc.child.kill("SIGKILL");
          } else proc.child.kill("SIGTERM");
        } else if (method === "SendInput") {
          const input = isRecord(message.input) ? message.input : {};
          const bytes = Buffer.from(String(input.stdin ?? ""), "base64");

          if (proc.guestStdin) proc.guestStdin.push(bytes);
          else proc.child.stdin?.write(bytes);
        } else if (method === "CloseStdin")
          proc.child.stdin?.end(
            proc.guestStdin
              ? mapGuestInput(Buffer.concat(proc.guestStdin).toString(), machine.mapped)
              : undefined,
          );
        else {
          json(response, 404, { code: "unimplemented", message: "no such method" });

          return;
        }

        json(response, 200, {});
      }),
    );

  const fake: FakeE2B = {
    server,
    machines,
    calls,
    listQueries,
    nativeKills,
    reconnects,
    starts,
    sandboxDomain: "e2b.test",
    envdVersion: "0.10.0",
    createDelayMs: 0,
    startDelayMs: 0,
    launchGroupLeader: false,
    count: (route) => server.calls(route).length,
    pause(id) {
      const machine = machines.get(id);

      if (!machine) throw new Error("fake e2b: no such sandbox");
      machine.info.state = "paused";
      clearTimeout(machine.timer);
    },
    kill,
    fetch(original) {
      return async (input, init) => {
        const url = new URL(
          isString(input) ? input : input instanceof URL ? input.href : input.url,
        );

        const port = /^(\d+)-([^.]+)\./.exec(url.hostname);

        if (port?.[1] && port[1] !== "49983") {
          const machine = machines.get(port[2] ?? "");

          if (!machine) throw new TypeError("fetch failed");

          return original(`http://127.0.0.1:${machine.port}${url.pathname}${url.search}`, init);
        }

        if (!port && !/^(api|sandbox)\./.test(url.hostname)) return original(input, init);
        const headers = new Headers(init?.headers);
        headers.set("x-fake-host", url.host);

        return original(`${server.url}${url.pathname}${url.search}`, { ...init, headers });
      };
    },
    async close() {
      await Promise.all([...machines.keys()].map(kill));

      for (const path of snapshots.values()) await fs.rm(path, { recursive: true, force: true });
      snapshots.clear();
      await server.close();
    },
  };

  return fake;
}

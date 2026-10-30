/**
 * A fake Superserve for unit tests: the control plane, the data plane and `exec/connect`, speaking the wire
 * protocol @superserve/sdk 0.11.4 speaks. Install it with `installSuperserveFake()`, which stubs the global
 * `fetch` and `WebSocket`. Guest commands and files run on Linux through MockGuest.
 */
import type { JsonObject, JsonValue } from "../src/shared/json.js";
import { isNumber, isObject, isString } from "../src/shared/narrow.js";
import { vi } from "vitest";
import { MockGuest } from "./mock-guest.js";
import { quote } from "../src/shared/shell.js";

export const api = "https://api.superserve.ai";
export const dataHost = "https://sandbox.superserve.ai";

interface Box {
  guest: MockGuest;
  metadata: Record<string, string>;
  createdAt: Date;
  status: string;
  network?: { allow_out: string[]; deny_out: string[] };
  /** The only access token the data plane accepts. */
  token: string;
  hint: string;
}

/** A routing hint shaped like Superserve's: a JWT-like string whose payload's `e` is the expiry in seconds. */
export function routingHint(expiresInSeconds: number, tag = crypto.randomUUID()) {
  const payload = Buffer.from(
    JSON.stringify({ s: tag, e: Math.floor(Date.now() / 1000) + expiresInSeconds }),
  ).toString("base64url");

  return `eyJhbGciOiJFZERTQSJ9.${payload}.sig-${tag.slice(0, 8)}`;
}

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

export interface FakeSocket {
  url: string;
  protocols: string[];
  sent: (string | Uint8Array)[];
}

/** A promise with its resolver, for holding a fake response until the test releases it. */
export function gate() {
  let open = () => {};

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

export const state = {
  boxes: new Map<string, Box>(),
  // SAFETY: an empty start value, typed for what the tests store in it later.
  requests: [] as FakeRequest[],
  // SAFETY: an empty start value, typed for what the tests store in it later.
  sockets: [] as FakeSocket[],
  creates: 0,
  nativeTimeoutSeconds: 0,
  bootstrapPath: "",
  updates: new Array<unknown>(),
  // SAFETY: an empty start value, typed for what the tests store in it later.
  createOptions: undefined as unknown,
  transportFailure: false,
  stdinFailure: false,
  closes: 0,
  // SAFETY: an empty start value, typed for what the tests store in it later.
  bootstrap: undefined as undefined | (() => Promise<void>),
  snapshotFailure: false,
  // SAFETY: an empty start value, typed for what the tests store in it later.
  snapshotOptions: undefined as unknown,
  dropNetwork: false,
  // SAFETY: an empty start value, typed for what the tests store in it later.
  previewAccess: [] as unknown[],
  /** Lifetime of the routing hints the fake hands out. */
  hintSeconds: 3600,
  /** Hand out routes with no routing hint, as an older control plane does. */
  noHints: false,
  /** Held activate or resume responses: the response leaves when the gate opens. Minted when the request arrives. */
  // SAFETY: an empty start value, typed for what the tests store in it later.
  activateGate: undefined as Promise<void> | undefined,
  // SAFETY: an empty start value, typed for what the tests store in it later.
  resumeGate: undefined as Promise<void> | undefined,
  /** Answer the next data-plane requests with these failures instead (status, JSON or text body). */
  // SAFETY: an empty start value, typed for what the tests store in it later.
  dataFaults: [] as { status: number; body: JsonValue | undefined }[],
  /** Hold the create response (the sandbox already exists) until the gate opens. */
  // SAFETY: an empty start value, typed for what the tests store in it later.
  createGate: undefined as Promise<void> | undefined,
  /** Drop the next `exec/connect` sessions after the command starts, with close code 1006. */
  dropSessions: 0,
  /** Answer the next POST /exec with a 200 whose JSON body is cut short. */
  cutExec: 0,
  /** Hold data-plane responses (decided when the request arrives) until the gate opens. */
  // SAFETY: an empty start value, typed for what the tests store in it later.
  dataGate: undefined as Promise<void> | undefined,
  /** Refuse the next `exec/connect` dials, as a stale token does (an `error` event and no `close`). */
  refuseDials: 0,
};

let minted = 0;
const mint = () => `tok${++minted}-${crypto.randomUUID().replaceAll("-", "")}`;

/** Any value JSON.stringify accepts: the fake answers with plain objects and class-free records. */
type Serializable = Parameters<typeof JSON.stringify>[0];

const json = (status: number, body: Serializable) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const missing = () => json(404, { error: { code: "not_found", message: "sandbox not found" } });

/** Rotates a sandbox's token on the server, so the one a client holds is refused with a 401. */
export function revoke(id: string) {
  const box = state.boxes.get(id);

  if (box) box.token = mint();
}

export function tokenOf(id: string) {
  return state.boxes.get(id)?.token;
}

export const activations = (id: string) =>
  state.requests.filter(
    (r) => r.method === "POST" && r.url.pathname === `/sandboxes/${id}/activate`,
  ).length;

export const dataRequests = (id: string) =>
  state.requests.filter(
    (r) => r.url.origin === dataHost && r.headers.get("x-superserve-sandbox-id") === id,
  );

function info(id: string, box: Box, extra: JsonObject = {}) {
  return {
    id,
    name: `sbxsdk-${id}`,
    status: box.status,
    vcpu_count: 1,
    memory_mib: 1024,
    created_at: box.createdAt.toISOString(),
    metadata: box.metadata,
    preview_access: "private",
    ...(box.network ? { network: box.network } : undefined),
    ...(state.nativeTimeoutSeconds > 0
      ? { timeout_seconds: state.nativeTimeoutSeconds }
      : undefined),
    ...extra,
  };
}

// The guest runs on the host, so map the sandbox's absolute paths into its directory and back.
function launch(g: MockGuest, command: string) {
  const mapping = `
def sdk_paths(value):
 if isinstance(value,str): return value.replace("/"+"workspace",bytes.fromhex("${Buffer.from(g.root + "/workspace").toString("hex")}").decode()).replace("/tmp/"+".sandbox-sdk",bytes.fromhex("${Buffer.from(g.root + "/tmp/.sandbox-sdk").toString("hex")}").decode())
 if isinstance(value,list): return [sdk_paths(x) for x in value]
 if isinstance(value,dict): return {k:sdk_paths(x) for k,x in value.items()}
 return value
v=sdk_paths(v)`;

  return command
    .replace(
      "else marshal.loads(bytes.fromhex(sys.stdin.read()))",
      "else marshal.loads(bytes.fromhex(sys.stdin.read()))" + mapping,
    )
    .replace("data.hex()", `data.replace(${JSON.stringify(g.root)}.encode(),bytes()).hex()`);
}

const normalize = (g: MockGuest, value: string) =>
  value.replace(
    "base64.b64encode(data)",
    `base64.b64encode(data.replace(${JSON.stringify(g.root)}.encode(),bytes()))`,
  );

const record = (value: JsonValue | undefined): JsonObject =>
  isObject(value) ? Object.fromEntries(Object.entries(value)) : {};

const list = (value: JsonValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

const strings = (value: JsonValue | undefined): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value)).filter((e): e is [string, string] => typeof e[1] === "string"),
  );

async function control(method: string, url: URL, body: JsonValue | undefined): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "snapshots")
    return json(200, {
      id: parts[1],
      sandbox_id: "x",
      status: "ready",
      created_at: new Date().toISOString(),
    });

  if (parts[0] !== "sandboxes") return json(404, { error: "no route" });
  const [, id, action, port, sub] = parts;

  if (id === undefined) {
    if (method === "GET")
      return json(
        200,
        [...state.boxes.entries()].map(([key, box]) => info(key, box)),
      );
    const options = record(body);
    const guest = await MockGuest.create();
    state.creates++;
    state.createOptions = options;
    const network = record(options.network);

    const box: Box = {
      guest,
      metadata: strings(options.metadata),
      createdAt: new Date(),
      status: "active",
      token: mint(),
      hint: routingHint(state.hintSeconds),
      ...(options.network && !state.dropNetwork
        ? { network: { allow_out: list(network.allow_out), deny_out: list(network.deny_out) } }
        : undefined),
    };

    state.boxes.set(guest.id, box);

    if (state.createGate) await state.createGate;

    return json(
      201,
      info(guest.id, box, {
        access_token: box.token,
        ...(state.noHints ? undefined : { routing_hint: box.hint }),
      }),
    );
  }

  const box = state.boxes.get(id);

  if (method === "DELETE" && action === undefined) {
    if (!box) return missing();
    await box.guest.destroy();
    state.boxes.delete(id);

    return new Response(null, { status: 204 });
  }

  if (!box) return missing();

  if (method === "GET" && action === undefined) return json(200, info(id, box));

  if (method === "PATCH" && action === undefined) {
    state.updates.push(body);

    return new Response(null, { status: 204 });
  }

  if (action === "activate" || action === "resume") {
    // A resume rotates the token. An activate keeps a valid one, as the live service does.
    if (action === "resume") box.token = mint();
    box.status = "active";
    box.hint = routingHint(state.hintSeconds);

    const answer = info(id, box, {
      access_token: box.token,
      ...(state.noHints ? undefined : { routing_hint: box.hint }),
    });

    const held = action === "activate" ? state.activateGate : state.resumeGate;

    if (held) await held;

    return json(200, answer);
  }

  if (action === "pause") {
    box.status = "paused";

    return json(200, { status: "paused" });
  }

  if (action === "snapshot") {
    state.snapshotOptions = body;

    if (state.snapshotFailure)
      return json(500, { error: { code: "internal", message: "private-native-token" } });

    return json(201, {
      id: "snapshot-1",
      sandbox_id: id,
      status: "ready",
      created_at: new Date().toISOString(),
    });
  }

  if (action === "preview-ports" && port === undefined) {
    state.previewAccess.push(body);
    const value = record(body);

    return json(200, { port: value.port, token_version: 1, access: value.access ?? "private" });
  }

  if (action === "preview-ports" && sub === "token")
    return json(200, {
      token: "mock",
      header: "x-preview",
      query_param: "_t",
      port: Number(port),
      token_version: 1,
      access: "private",
    });

  return json(404, { error: "no route" });
}

async function data(
  method: string,
  url: URL,
  headers: Headers,
  body: JsonValue | undefined,
  raw: Uint8Array | undefined,
): Promise<Response> {
  const id = headers.get("x-superserve-sandbox-id") ?? "";
  const box = state.boxes.get(id);

  if (!box) return json(404, { error: { code: "sandbox_not_found", message: "no sandbox" } });
  const fault = state.dataFaults.shift();

  if (fault)
    return isString(fault.body)
      ? new Response(fault.body, {
          status: fault.status,
          headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" },
        })
      : json(fault.status, fault.body);
  const valid = headers.get("x-access-token") === box.token;

  if (state.dataGate) await state.dataGate;

  if (!valid) return new Response("invalid access token\n", { status: 401 });
  const g = box.guest;
  const path = url.searchParams.get("path") ?? "";

  if (url.pathname === "/files" && method === "POST") {
    await g.upload(path, raw ?? new Uint8Array());

    return new Response(null, { status: 200 });
  }

  if (url.pathname === "/files" && method === "GET") {
    try {
      return new Response(await g.read(path), { status: 200 });
    } catch {
      return json(404, { error: "file not found" });
    }
  }

  if (url.pathname === "/exec" && method === "POST") {
    const options = record(body);
    const command = String(options.command);
    const env = strings(options.env);

    if (env.SANDBOX_SDK_BOOTSTRAP) await state.bootstrap?.();

    if (state.cutExec > 0) {
      state.cutExec--;

      return new Response('{"stdout":"partial', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (state.transportFailure) {
      state.transportFailure = false;
      void g.raw(command).catch(() => {});
      throw new TypeError("fetch failed: private-native-token");
    }

    if (env.SANDBOX_SDK_BOOTSTRAP && state.bootstrapPath) env.PATH = state.bootstrapPath;

    const prefix = Object.entries(env)
      .map(
        ([key, value]) =>
          `export ${key}=${quote(key === "SANDBOX_SDK_BOOTSTRAP" ? normalize(g, value) : value)};`,
      )
      .join(" ");

    try {
      return json(200, {
        stdout: await g.raw(`${prefix} ${launch(g, command)}`),
        stderr: "",
        exit_code: 0,
      });
    } catch (error) {
      const failed: JsonObject = isObject(error) ? Object.fromEntries(Object.entries(error)) : {};

      if (isNumber(failed.code))
        return json(200, {
          stdout: isString(failed.stdout) ? failed.stdout : "",
          stderr: isString(failed.stderr) ? failed.stderr : "",
          exit_code: failed.code,
        });
      throw error;
    }
  }

  return json(404, { error: "no route" });
}

async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(isString(input) ? input : input instanceof URL ? input.href : input.url);

  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  init.signal?.throwIfAborted();
  const raw = init.body instanceof Uint8Array ? init.body : undefined;
  const text = isString(init.body) ? init.body : undefined;
  const body: JsonValue | undefined = text === undefined ? undefined : JSON.parse(text);
  state.requests.push({ method, url, headers, body });

  if (url.origin === api) {
    if (headers.get("x-api-key") !== "mock")
      return json(401, { error: { code: "unauthorized", message: "bad key" } });

    return control(method, url, body);
  }

  if (url.origin === dataHost) return data(method, url, headers, body, raw);
  throw new TypeError(`fetch failed: no fake host for ${url.origin}`);
}

type Listener = (event: never) => void;

/** What the fake socket dispatches: an open or close notice, or a message with its data. */
type FakeSocketEvent = { data?: string | ArrayBuffer | Uint8Array; code?: number; reason?: string };

/** The subset of the WebSocket API session.ts uses, driving a MockGuest stream. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  protocol = "";
  private listeners = new Map<string, Set<Listener>>();
  private stream: ReturnType<MockGuest["stream"]> | undefined;
  private readonly record: FakeSocket;
  constructor(
    readonly url: string,
    protocols: string[] = [],
  ) {
    this.record = { url, protocols, sent: [] };
    state.sockets.push(this.record);
    const id = /^wss:\/\/boxd-([^.]+)\.sandbox\.superserve\.ai\/exec\/connect$/.exec(url)?.[1];
    const box = id === undefined ? undefined : state.boxes.get(id);
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      const refused = state.refuseDials > 0;

      if (refused) state.refuseDials--;

      if (
        refused ||
        !box ||
        !protocols.includes(`token.${box.token}`) ||
        !protocols.includes("superserve.exec.v1")
      ) {
        // Like Node 22's WebSocket on a refused upgrade: an error event, and no close.
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("error", {});

        return;
      }

      this.readyState = FakeWebSocket.OPEN;
      this.protocol = "superserve.exec.v1";
      this.emit("open", {});
    });
    this.box = box;
  }
  private readonly box: Box | undefined;
  addEventListener(type: string, listener: Listener) {
    let set = this.listeners.get(type);

    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }
  private emit(type: string, event: FakeSocketEvent) {
    for (const listener of this.listeners.get(type) ?? [])
      // SAFETY: listeners for this event type are registered with this signature.
      (listener as (event: FakeSocketEvent) => void)(event);
  }
  private binary(channel: number, bytes: Uint8Array) {
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = channel;
    frame.set(bytes, 1);
    this.emit("message", { data: frame.buffer });
  }
  send(data: string | Uint8Array) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("not open");
    this.record.sent.push(data);
    const g = this.box?.guest;

    if (!g) return;

    if (!isString(data)) {
      if (state.stdinFailure) {
        state.stdinFailure = false;
        throw new Error("private-input-error");
      }

      this.stream?.write(new TextDecoder().decode(data.subarray(1)));

      return;
    }

    const frame = record(JSON.parse(data));

    if (frame.type === "stdin_close") {
      this.stream?.end();

      return;
    }

    if (frame.type === "signal") {
      this.stream?.close();

      return;
    }

    if (!isString(frame.command)) return;

    const prefix = Object.entries(strings(frame.env))
      .map(([key, value]) => `export ${key}=${quote(normalize(g, value))};`)
      .join(" ");

    const stream = g.stream(`${prefix} ${launch(g, frame.command)}`);
    this.stream = stream;

    if (state.dropSessions > 0) {
      state.dropSessions--;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("close", { code: 1006, reason: "" });
      });
    }

    stream.stdout.push = (bytes) => this.binary(1, Buffer.from(Buffer.from(bytes).toString()));
    stream.stderr.push = (bytes) => this.binary(2, Buffer.from(bytes));
    void stream.wait().then(
      (code) => {
        if (this.readyState === FakeWebSocket.OPEN)
          this.emit("message", { data: JSON.stringify({ exit_code: code, finished: true }) });
      },
      () => {},
    );
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    const wasOpen = this.readyState === FakeWebSocket.OPEN;
    this.readyState = FakeWebSocket.CLOSED;
    state.closes++;
    this.stream?.close();

    if (wasOpen) queueMicrotask(() => this.emit("close", { code: 1000, reason: "" }));
  }
}

/** Stubs `fetch` and `WebSocket` with the fake. Call `vi.unstubAllGlobals()` to undo it. */
export function installSuperserveFake() {
  vi.stubGlobal("fetch", fakeFetch);
  vi.stubGlobal("WebSocket", FakeWebSocket);
}

export async function resetSuperserveFake() {
  for (const box of state.boxes.values()) await box.guest.destroy();
  state.boxes.clear();
}

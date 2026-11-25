// A local stand-in for Microsandbox Cloud, for the adapter's tests: the REST control plane
// (https://api.microsandbox.dev/docs/openapi.json, plus the Services routes of the official SDK) over HTTP,
// and a mock of the `microsandbox` peer whose `RemoteContext` reaches the same sandboxes. Each sandbox is a
// temporary directory; `/workspace`, `/tmp/.sandbox-sdk` and `/tmp/sdk-bare` in commands and paths map into
// it, and commands run as real process groups. Faults let a test lose, refuse or delay answers.
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  MicrosandboxModule,
  PeerContextOptions,
  PeerExecEvent,
  PeerExecHandle,
  PeerExecOptions,
  PeerSandbox,
} from "../src/providers/microsandbox/exec.js";
import type { JsonObject, JsonValue } from "../src/shared/json.js";
import { isString } from "../src/shared/narrow.js";

type Status =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "saving_state"
  | "stopped"
  | "failed";

export interface FakeSandbox {
  id: string;
  name: string;
  root: string;
  status: Status;
  compute: "standard" | "shared";
  labels: Record<string, string>;
  env: Record<string, string>;
  resources: JsonObject;
  network: JsonValue;
  lifecycle: JsonValue;
  source: string;
  reference: string | null;
  createdAt: string;
  children: Set<ChildProcess>;
  /** The guest's boot ID, new at create and each start. Commands read it at `/proc/sys/kernel/random/boot_id`. */
  bootId: string;
}

export interface FakeService {
  slug: string;
  target: { sandbox: string; port: number } | null;
  status: "enabled" | "disabled" | "detached";
  createdAt?: string;
}

export interface FakeSnapshot {
  id: string;
  name: string;
  sandboxId: string;
  labels: Record<string, string>;
  root: string;
}

export interface FakeOperation {
  id: string;
  snapshotName: string;
  sandboxId: string;
  status: "queued" | "in_progress" | "succeeded" | "failed";
  pendingReads: number;
  snapshotId: string | undefined;
  /** The finished snapshot as the operation reported it; kept after the snapshot is deleted. */
  result: JsonValue | undefined;
  fails: boolean;
}

/** What a test can make the fake do wrong, each consumed or kept as documented. */
export interface Faults {
  /** The next create is applied, then answered with this status, dropped, or with an unreadable body. Consumed. */
  createAnswer?: number | "drop" | "unreadable";
  /** The next create is refused with this status before anything is made. Consumed. */
  createRefuse?: number;
  /** The error code of the next refusal (`createRefuse`). Consumed. */
  refuseCode?: string;
  /** The next create makes nothing and answers with this status. Consumed. */
  createLost?: number;
  /** The next create's sandbox carries another call's allocation marker, and its answer is dropped. Consumed. */
  foreignMarker?: boolean;
  /** New sandboxes start in this status instead of running. Kept. */
  createStatus?: "created" | "starting";
  /** Polls of a `starting` sandbox before it runs. Kept. */
  startingReads?: number;
  /** Reads by name answer 404 this many more times. */
  byNameMissing?: number;
  /** Sandbox reads answer `spec: null` this many more times. */
  specNull?: number;
  /** Sandboxes report this compute type, whatever was asked. Kept. */
  compute?: "standard" | "shared";
  /** A start leaves the sandbox `failed`. Kept. */
  startFails?: boolean;
  /** Starts answer 500 and leave the sandbox stopped. Kept. */
  startRefuse?: boolean;
  /** `POST /v1/snapshots` is refused with this status. Consumed. */
  snapshotRefuse?: number;
  /** `POST /v1/snapshots` is applied, then its answer dropped. Consumed. */
  snapshotDrop?: boolean;
  /** The next capture operation fails. Consumed. */
  operationFails?: boolean;
  /** Reads of an operation before it finishes. Kept. */
  operationPendingReads?: number;
  /** A finished capture records this source instead of the real one, without the source label. Consumed. */
  snapshotForeignSource?: string;
  /**
   * A sandbox DELETE is accepted, and the sandbox still answers this many more reads by ID (and stays
   * listed) before it is gone, as Microsandbox finishes a delete later. `Infinity` never finishes. Kept.
   */
  deleteLingerReads?: number;
  /** `DELETE /v1/services/{slug}` answers 500. Kept. */
  serviceDeleteFails?: boolean;
  /** Slugs another organization holds: `POST /v1/services` answers 409. Kept. */
  takenSlugs?: Set<string>;
  /** `POST /v1/services` is applied, then its answer dropped. Consumed. */
  serviceDrop?: boolean;
}

export interface MicrosandboxFake {
  /** `http://127.0.0.1:<port>`, for `microsandbox({ baseUrl })`. */
  readonly url: string;
  readonly sandboxes: Map<string, FakeSandbox>;
  readonly services: Map<string, FakeService>;
  readonly snapshots: Map<string, FakeSnapshot>;
  readonly operations: Map<string, FakeOperation>;
  /** Every request answered: method, path with query, and the JSON body read. */
  readonly requests: { method: string; path: string; body: JsonValue | undefined }[];
  /** Every `RemoteContext` the peer built, with the options it got. */
  readonly contexts: PeerContextOptions[];
  /** Every command the peer launched. */
  readonly execs: {
    sandbox: string;
    cmd: string;
    args: string[];
    cwd: string | undefined;
    env: Record<string, string>;
    tty: boolean | undefined;
    stdin: "null" | Uint8Array | undefined;
  }[];
  readonly faults: Faults;
  /** The mock `microsandbox` module. */
  readonly peer: MicrosandboxModule;
  close(): Promise<void>;
}

const strings = z.record(z.string(), z.string());

const createBody = z.object({
  compute: z.object({ type: z.enum(["standard", "shared"]) }).optional(),
  spec: z.looseObject({
    name: z.string(),
    source: z.enum(["oci", "disk_snapshot"]),
    reference: z.string().optional(),
    disk_snapshot_ref: z.object({ type: z.literal("managed"), id: z.string() }).optional(),
    labels: strings.default({}),
    env: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
    resources: z.record(z.string(), z.number()).optional(),
    network: z.json().optional(),
    lifecycle: z.json().optional(),
  }),
});

const snapshotBody = z.object({
  kind: z.literal("disk"),
  sandbox_id: z.string(),
  name: z.string(),
  labels: strings.default({}),
});

const serviceBody = z.object({
  slug: z.string(),
  target: z.object({ sandbox: z.string(), port: z.number().int() }),
});

/** A peer error with the shape `MicrosandboxError` has: a string `code`. */
export class FakePeerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const mapped = (sandbox: FakeSandbox, text: string) =>
  text.replace(
    /\/workspace|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare|\/proc\/sys\/kernel\/random\/boot_id/g,
    (path) => join(sandbox.root, path),
  );

async function readBody(request: IncomingMessage): Promise<JsonValue | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();

  return text ? z.json().parse(JSON.parse(text)) : undefined;
}

/** One command's events as the peer's `ExecHandle` hands them out. */
class FakeHandle implements PeerExecHandle {
  private readonly queue: PeerExecEvent[] = [];
  private readonly waiting: ((event: PeerExecEvent | null) => void)[] = [];
  private ended = false;
  readonly exit: Promise<{ code: number }>;
  private settle!: (status: { code: number }) => void;
  kills = 0;

  constructor(readonly child: ChildProcess) {
    this.exit = new Promise((resolve) => (this.settle = resolve));
  }

  push(event: PeerExecEvent) {
    const next = this.waiting.shift();

    if (next) next(event);
    else this.queue.push(event);
  }

  finish(code: number) {
    this.push({ kind: "exited", code });
    this.ended = true;
    this.settle({ code });

    for (const next of this.waiting.splice(0)) next(null);
  }

  recv(): Promise<PeerExecEvent | null> {
    const event = this.queue.shift();

    if (event) return Promise.resolve(event);

    if (this.ended) return Promise.resolve(null);

    return new Promise((resolve) => this.waiting.push(resolve));
  }

  wait() {
    return this.exit;
  }

  async kill() {
    this.kills++;

    try {
      if (this.child.pid !== undefined) process.kill(-this.child.pid, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }
}

/** The exec options builder: records what the adapter configured. */
class FakeOptions implements PeerExecOptions {
  argv: string[] = [];
  dir: string | undefined;
  vars: Record<string, string> = {};
  terminal: boolean | undefined;
  stdin: "null" | Uint8Array | undefined;

  args(args: string[]) {
    this.argv.push(...args);

    return this;
  }

  cwd(cwd: string) {
    this.dir = cwd;

    return this;
  }

  envs(vars: Record<string, string>) {
    Object.assign(this.vars, vars);

    return this;
  }

  tty(enabled: boolean) {
    this.terminal = enabled;

    return this;
  }

  stdinNull() {
    this.stdin = "null";

    return this;
  }

  stdinBytes(data: Buffer) {
    this.stdin = new Uint8Array(data);

    return this;
  }
}

export async function microsandboxFake(): Promise<MicrosandboxFake> {
  const sandboxes = new Map<string, FakeSandbox>();
  const services = new Map<string, FakeService>();
  const snapshots = new Map<string, FakeSnapshot>();
  const operations = new Map<string, FakeOperation>();
  const requests: MicrosandboxFake["requests"] = [];
  const contexts: PeerContextOptions[] = [];
  const execs: MicrosandboxFake["execs"] = [];
  const faults: Faults = {};
  const starting = new Map<string, number>();
  /** Sandboxes whose accepted DELETE has not finished, with the reads by ID left before it does. */
  const deleting = new Map<string, number>();
  const work = await mkdtemp(join(tmpdir(), "msb-fake-"));
  let origin = "";

  const json = (response: ServerResponse, status: number, value?: JsonValue) =>
    response
      .writeHead(status, value === undefined ? {} : { "content-type": "application/json" })
      .end(value === undefined ? undefined : JSON.stringify(value));

  // Microsandbox's nested error shape: `{ error: { code, message } }`.
  const failure = (response: ServerResponse, status: number, code: string) =>
    json(response, status, { error: { code, message: code } });

  const byName = (name: string) => [...sandboxes.values()].find((s) => s.name === name);

  function view(sandbox: FakeSandbox): JsonValue {
    const unresolved = (faults.specNull ?? 0) > 0;

    if (unresolved) faults.specNull = (faults.specNull ?? 1) - 1;

    return {
      id: sandbox.id,
      org_id: "00000000-0000-0000-0000-00000000000a",
      name: sandbox.name,
      slug: sandbox.name.slice(0, 40),
      status: sandbox.status,
      compute: { type: sandbox.compute },
      ephemeral: false,
      created_at: sandbox.createdAt,
      started_at: null,
      stopped_at: null,
      spec: unresolved
        ? null
        : {
            image: sandbox.reference,
            labels: sandbox.labels,
            resources: sandbox.resources,
            env: Object.entries(sandbox.env).map(([key, value]) => ({ key, value })),
            lifecycle: sandbox.lifecycle,
            network: sandbox.network,
            runtime: {},
            rlimits: [],
            mounts: [],
          },
    };
  }

  function stopChildren(sandbox: FakeSandbox) {
    for (const child of sandbox.children)
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }

    sandbox.children.clear();
  }

  /** Advances a `starting` sandbox one poll; it runs after `startingReads` polls. */
  function advance(sandbox: FakeSandbox) {
    if (sandbox.status !== "starting") return;
    const left = starting.get(sandbox.id) ?? faults.startingReads ?? 0;

    if (left <= 0) {
      sandbox.status = faults.startFails ? "failed" : "running";
      starting.delete(sandbox.id);
    } else starting.set(sandbox.id, left - 1);
  }

  function snapshotView(snapshot: FakeSnapshot): JsonValue {
    return {
      kind: "disk",
      name: snapshot.name,
      location: { type: "managed", id: snapshot.id },
      sandbox_id: snapshot.sandboxId,
      labels: snapshot.labels,
      digest: `sha256:${snapshot.id.replaceAll("-", "")}`,
      size_bytes: 1,
      manifest: {},
      created_at: new Date().toISOString(),
    };
  }

  function operationView(op: FakeOperation): JsonValue {
    return {
      id: op.id,
      kind: "disk",
      status: op.status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error: op.status === "failed" ? { code: "capture_failed", message: "failed" } : null,
      result: op.status === "succeeded" ? (op.result ?? null) : null,
      snapshot_name: op.snapshotName,
      sandbox_id: op.sandboxId,
      sandbox_name: sandboxes.get(op.sandboxId)?.name ?? "",
      destination_kind: "managed",
    };
  }

  /** Moves an operation one read forward; at the end it copies the source's disk. */
  async function progress(op: FakeOperation) {
    if (op.status === "succeeded" || op.status === "failed") return;

    if (op.pendingReads > 0) {
      op.pendingReads--;
      op.status = "in_progress";

      return;
    }

    if (op.fails) {
      op.status = "failed";

      return;
    }

    const source = sandboxes.get(op.sandboxId);
    const id = crypto.randomUUID();
    const root = join(work, `snapshot-${id}`);

    // A disk snapshot keeps each file's modification time.
    if (source) await cp(source.root, root, { recursive: true, preserveTimestamps: true });
    else await mkdir(root, { recursive: true });
    const foreign = faults.snapshotForeignSource;
    faults.snapshotForeignSource = undefined;

    snapshots.set(id, {
      id,
      name: op.snapshotName,
      sandboxId: foreign ?? op.sandboxId,
      labels: foreign ? {} : (pendingLabels.get(op.id) ?? {}),
      root,
    });
    op.snapshotId = id;
    op.status = "succeeded";
    const made = snapshots.get(id);

    op.result = made === undefined ? undefined : snapshotView(made);
  }

  const pendingLabels = new Map<string, Record<string, string>>();
  let lastServiceTimeMs = 0;

  function nextServiceCreatedAt(): string {
    lastServiceTimeMs = Math.max(Date.now(), lastServiceTimeMs + 1);

    return new Date(lastServiceTimeMs).toISOString();
  }

  function servicesView(service: FakeService): JsonValue {
    service.createdAt ??= nextServiceCreatedAt();

    return {
      slug: service.slug,
      url: `${origin}/svc/${service.slug}`,
      status: service.status,
      target: service.target,
      created_at: service.createdAt,
      updated_at: new Date().toISOString(),
    };
  }

  async function createSandbox(response: ServerResponse, url: URL, raw: JsonValue | undefined) {
    if (faults.createRefuse !== undefined) {
      const status = faults.createRefuse;
      const code = faults.refuseCode ?? "invalid_request";
      faults.createRefuse = undefined;
      faults.refuseCode = undefined;

      return failure(response, status, code);
    }

    if (faults.createLost !== undefined) {
      const status = faults.createLost;
      faults.createLost = undefined;

      return failure(response, status, "internal_error");
    }

    const body = createBody.parse(raw);
    const spec = body.spec;

    if (byName(spec.name)) return failure(response, 409, "name_conflict");
    const id = crypto.randomUUID();
    const root = await mkdtemp(join(work, "sandbox-"));
    let reference: string | null = spec.reference ?? null;

    if (spec.source === "disk_snapshot") {
      const snapshot = snapshots.get(spec.disk_snapshot_ref?.id ?? "");

      if (!snapshot) return failure(response, 404, "snapshot_not_found");
      await cp(snapshot.root, root, { recursive: true, preserveTimestamps: true });
      reference = null;
    }

    for (const dir of ["workspace", "tmp/.sandbox-sdk", "tmp/sdk-bare", "proc/sys/kernel/random"])
      await mkdir(join(root, dir), { recursive: true });
    const start = url.searchParams.get("start") === "true";

    const sandbox: FakeSandbox = {
      id,
      name: spec.name,
      root,
      status: start ? (faults.createStatus ?? "running") : "created",
      compute: faults.compute ?? body.compute?.type ?? "standard",
      labels: spec.labels,
      env: Object.fromEntries(spec.env.map(({ key, value }) => [key, value])),
      resources: spec.resources ?? { vcpus: 1, memory_mib: 512 },
      network: spec.network ?? { enabled: true },
      lifecycle: spec.lifecycle ?? {},
      source: spec.source,
      reference,
      createdAt: new Date().toISOString(),
      children: new Set(),
      bootId: crypto.randomUUID(),
    };

    if (sandbox.status === "running" && faults.startFails) sandbox.status = "failed";

    if (faults.foreignMarker) {
      faults.foreignMarker = undefined;
      sandbox.labels = { ...sandbox.labels, "sandbox-sdk-alloc": "another-call" };
      faults.createAnswer = "drop";
    }

    sandboxes.set(id, sandbox);
    const answer = faults.createAnswer;
    faults.createAnswer = undefined;

    if (answer === "drop") return response.socket?.destroy();

    if (answer === "unreadable")
      return response.writeHead(200, { "content-type": "application/json" }).end("{");

    if (answer !== undefined) return failure(response, answer, "internal_error");
    json(response, 200, view(sandbox));
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    const body = await readBody(request);
    requests.push({ method, path: `${url.pathname}${url.search}`, body });

    if (request.headers.authorization !== "Bearer msb_fake_key_0123456789")
      return failure(response, 401, "unauthorized");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (parts[0] !== "v1") return failure(response, 404, "not_found");
    const [, resource, a, b] = parts;

    if (resource === "sandboxes") {
      if (a === undefined && method === "POST") return createSandbox(response, url, body);

      if (a === undefined && method === "GET") {
        const filter = strings.parse(JSON.parse(url.searchParams.get("labels") ?? "{}"));
        const limit = Number(url.searchParams.get("limit") ?? "20");
        const offset = Number(url.searchParams.get("cursor") ?? "0");

        const matching = [...sandboxes.values()].filter((s) =>
          Object.entries(filter).every(([k, v]) => s.labels[k] === v),
        );

        const page = matching.slice(offset, offset + limit);
        const more = offset + limit < matching.length;

        return json(response, 200, {
          data: page.map(view),
          has_more: more,
          next_cursor: more ? String(offset + limit) : null,
        });
      }

      if (a === "by-name" && b !== undefined && method === "GET") {
        if ((faults.byNameMissing ?? 0) > 0) {
          faults.byNameMissing = (faults.byNameMissing ?? 1) - 1;

          return failure(response, 404, "sandbox_not_found");
        }

        const sandbox = byName(b);

        if (!sandbox) return failure(response, 404, "sandbox_not_found");
        advance(sandbox);

        return json(response, 200, view(sandbox));
      }

      const sandbox = a === undefined ? undefined : sandboxes.get(a);

      if (!sandbox) return failure(response, 404, "sandbox_not_found");

      /** Finishes the delete: the sandbox goes, and its Services are detached. */
      const remove = async () => {
        deleting.delete(sandbox.id);
        sandboxes.delete(sandbox.id);

        for (const service of services.values())
          if (service.target?.sandbox === sandbox.name) {
            service.target = null;
            service.status = "detached";
          }

        await rm(sandbox.root, { recursive: true, force: true });
      };

      if (b === undefined && method === "GET") {
        const left = deleting.get(sandbox.id);

        if (left !== undefined) {
          if (left <= 0) {
            await remove();

            return failure(response, 404, "sandbox_not_found");
          }

          deleting.set(sandbox.id, left - 1);
        }

        advance(sandbox);

        return json(response, 200, view(sandbox));
      }

      if (b === undefined && method === "DELETE") {
        stopChildren(sandbox);

        if (faults.deleteLingerReads !== undefined) {
          if (!deleting.has(sandbox.id)) deleting.set(sandbox.id, faults.deleteLingerReads);

          return json(response, 200, { message: "deleting" });
        }

        await remove();

        return json(response, 200, { message: "deleted" });
      }

      if (b === "start" && method === "POST") {
        if (faults.startRefuse) return failure(response, 500, "internal_error");

        if (sandbox.status === "running") return json(response, 200, view(sandbox));
        sandbox.status = faults.startFails ? "failed" : "running";
        sandbox.bootId = crypto.randomUUID();

        return json(response, 200, view(sandbox));
      }

      if (b === "stop" && method === "POST") {
        stopChildren(sandbox);
        sandbox.status = "stopped";

        return json(response, 200, view(sandbox));
      }

      return failure(response, 404, "not_found");
    }

    if (resource === "services") {
      if (a === undefined && method === "POST") {
        const parsed = serviceBody.parse(body);

        if (faults.takenSlugs?.has(parsed.slug)) return failure(response, 409, "already_exists");
        const existing = services.get(parsed.slug);

        if (existing) {
          const same =
            existing.status === "enabled" &&
            existing.target?.sandbox === parsed.target.sandbox &&
            existing.target.port === parsed.target.port;

          return same
            ? json(response, 200, servicesView(existing))
            : failure(response, 409, "already_exists");
        }

        if (!byName(parsed.target.sandbox)) return failure(response, 400, "invalid_request");

        const service: FakeService = {
          slug: parsed.slug,
          target: parsed.target,
          status: "enabled",
          createdAt: nextServiceCreatedAt(),
        };

        services.set(parsed.slug, service);

        if (faults.serviceDrop) {
          faults.serviceDrop = false;

          return response.socket?.destroy();
        }

        return json(response, 201, servicesView(service));
      }

      if (a === undefined && method === "GET") {
        const sandbox = url.searchParams.get("sandbox");

        const listed = [...services.values()]
          .filter((s) => sandbox === null || s.target?.sandbox === sandbox)
          .sort((x, y) => x.slug.localeCompare(y.slug));

        return json(response, 200, { data: listed.map(servicesView), next_cursor: null });
      }

      const service = a === undefined ? undefined : services.get(a);

      if (!service) return failure(response, 404, "service_not_found");

      if (method === "GET") return json(response, 200, servicesView(service));

      if (method === "DELETE") {
        if (faults.serviceDeleteFails) return failure(response, 500, "internal_error");
        services.delete(service.slug);

        return response.writeHead(204).end();
      }

      return failure(response, 404, "not_found");
    }

    if (resource === "snapshots") {
      if (a === undefined && method === "POST") {
        if (faults.snapshotRefuse !== undefined) {
          const status = faults.snapshotRefuse;
          faults.snapshotRefuse = undefined;

          return failure(response, status, "invalid_request");
        }

        const parsed = snapshotBody.parse(body);
        const source = sandboxes.get(parsed.sandbox_id);

        if (!source) return failure(response, 404, "sandbox_not_found");

        if (source.status !== "stopped") return failure(response, 409, "conflict");

        if ([...snapshots.values()].some((s) => s.name === parsed.name))
          return failure(response, 409, "already_exists");

        const op: FakeOperation = {
          id: crypto.randomUUID(),
          snapshotName: parsed.name,
          sandboxId: parsed.sandbox_id,
          status: "queued",
          pendingReads: faults.operationPendingReads ?? 0,
          snapshotId: undefined,
          result: undefined,
          fails: faults.operationFails === true,
        };

        faults.operationFails = undefined;
        pendingLabels.set(op.id, parsed.labels);
        operations.set(op.id, op);

        if (faults.snapshotDrop) {
          faults.snapshotDrop = undefined;

          return response.socket?.destroy();
        }

        return json(response, 202, operationView(op));
      }

      if (a === undefined && method === "GET")
        return json(response, 200, {
          data: [...snapshots.values()].map(snapshotView),
          has_more: false,
          next_cursor: null,
        });

      if (a === "by-name" && b !== undefined) {
        const snapshot = [...snapshots.values()].find((s) => s.name === b);

        if (!snapshot) return failure(response, 404, "snapshot_not_found");

        if (method === "GET") return json(response, 200, snapshotView(snapshot));

        if (method === "DELETE") {
          snapshots.delete(snapshot.id);
          await rm(snapshot.root, { recursive: true, force: true });

          return json(response, 200, { message: "deleted" });
        }
      }

      const snapshot = a === undefined ? undefined : snapshots.get(a);

      if (!snapshot) return failure(response, 404, "snapshot_not_found");

      if (method === "GET") return json(response, 200, snapshotView(snapshot));

      if (method === "DELETE") {
        snapshots.delete(snapshot.id);
        await rm(snapshot.root, { recursive: true, force: true });

        return json(response, 200, { message: "deleted" });
      }

      return failure(response, 404, "not_found");
    }

    if (resource === "snapshot-operations") {
      if (a === undefined) {
        for (const op of operations.values()) await progress(op);

        return json(response, 200, {
          data: [...operations.values()].reverse().map(operationView),
          has_more: false,
          next_cursor: null,
        });
      }

      const op = operations.get(a);

      if (!op) return failure(response, 404, "not_found");
      await progress(op);

      return json(response, 200, operationView(op));
    }

    return failure(response, 404, "not_found");
  }

  const server = createServer((request, response) => {
    route(request, response).catch(() => {
      if (!response.headersSent) failure(response, 500, "internal_error");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || isString(address)) throw new Error("The Microsandbox fake has no TCP port");
  origin = `http://127.0.0.1:${address.port}`;

  /** The peer's view of one sandbox. */
  function peerSandbox(name: string): PeerSandbox {
    const find = () => {
      const sandbox = byName(name);

      if (!sandbox) throw new FakePeerError("sandboxNotFound", `sandbox ${name} not found`);

      return sandbox;
    };

    /** The peer's error for a failed host file call, from its errno code. */
    const fsError = (errno: string | undefined) =>
      new FakePeerError(
        "sandboxFsOps",
        errno === "ENOENT"
          ? "No such file or directory (os error 2)"
          : errno === "EISDIR"
            ? "Is a directory (os error 21)"
            : "filesystem operation failed",
      );

    const errnoOf = (error: NodeJS.ErrnoException) => error.code;

    return {
      async execStreamWith(cmd, configure) {
        const sandbox = find();

        if (sandbox.status !== "running")
          throw new FakePeerError("sandboxNotRunning", `sandbox ${name} is not running`);
        const options = new FakeOptions();
        configure(options);
        execs.push({
          sandbox: name,
          cmd,
          args: options.argv,
          cwd: options.dir,
          env: options.vars,
          tty: options.terminal,
          stdin: options.stdin,
        });
        const cwd = mapped(sandbox, options.dir ?? "/");
        await writeFile(
          join(sandbox.root, "proc/sys/kernel/random/boot_id"),
          `${sandbox.bootId}\n`,
        );

        const child = spawn(
          cmd,
          options.argv.map((part) => mapped(sandbox, part)),
          {
            cwd: cwd === "/" ? sandbox.root : cwd,
            env: { ...process.env, ...sandbox.env, ...options.vars },
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          },
        );

        sandbox.children.add(child);
        const handle = new FakeHandle(child);
        // Output names guest paths, as a real sandbox would.

        const guest = (data: Buffer) =>
          new Uint8Array(
            Buffer.from(data.toString("latin1").split(sandbox.root).join(""), "latin1"),
          );

        child.stdout?.on("data", (data: Buffer) =>
          handle.push({ kind: "stdout", data: guest(data) }),
        );
        child.stderr?.on("data", (data: Buffer) =>
          handle.push({ kind: "stderr", data: guest(data) }),
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(
          options.stdin instanceof Uint8Array ? Buffer.from(options.stdin) : undefined,
        );
        child.on("close", (code, signal) => {
          sandbox.children.delete(child);
          handle.finish(code ?? (signal === null ? 1 : 128 + 9));
        });
        await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
        handle.push({ kind: "started", pid: child.pid ?? 0 });

        return handle;
      },
      fs() {
        return {
          async read(path: string) {
            const sandbox = find();

            try {
              return new Uint8Array(await readFile(mapped(sandbox, path)));
            } catch (error) {
              throw fsError(error instanceof Error ? errnoOf(error) : undefined);
            }
          },
          async write(path: string, data: Uint8Array) {
            const sandbox = find();

            try {
              await writeFile(mapped(sandbox, path), data);
            } catch (error) {
              throw fsError(error instanceof Error ? errnoOf(error) : undefined);
            }
          },
        };
      },
    };
  }

  class RemoteContext {
    readonly sandboxes = {
      get: async (name: string) => {
        if (!byName(name)) throw new FakePeerError("sandboxNotFound", `sandbox ${name} not found`);

        return peerSandbox(name);
      },
    };

    constructor(options: PeerContextOptions) {
      contexts.push(options);
    }
  }

  return {
    url: origin,
    sandboxes,
    services,
    snapshots,
    operations,
    requests,
    contexts,
    execs,
    faults,
    peer: { RemoteContext },
    async close() {
      for (const sandbox of sandboxes.values()) stopChildren(sandbox);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await rm(work, { recursive: true, force: true });
    },
  };
}

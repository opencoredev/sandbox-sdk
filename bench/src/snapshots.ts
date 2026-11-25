import { z } from "zod";
import type { DaytonaNative } from "@opencoredev/sandbox-sdk/daytona";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import {
  daytonaClient,
  e2bConnection,
  upstashConnection,
  localDocker,
  lookupError,
  nativeModules,
  styneEnded,
  styneErrorCode,
  type NativeModules,
  type StyneTarget,
} from "./existence.js";
import {
  capturedFrom,
  deleteMicrosandboxSnapshot,
  microsandboxSnapshotsFromSource,
  readMicrosandboxSnapshot,
  recordedSource,
  settleMicrosandboxCapture,
  isMicrosandboxSnapshotId,
} from "./microsandbox.js";
import { microsandboxTier } from "./providers.js";
import { connectionOf, endpoint, modalClientParams } from "./connections.js";
import { deadline } from "./timing.js";
import { snapshotProvenanceSchema, type SnapshotProvenance } from "./ownership.js";

// Every native client here uses the connection of the adapter instance that took the snapshots.

async function daytonaSnapshots(provider: Provider) {
  return (await daytonaClient(provider)).snapshot;
}

async function boxdSnapshots(provider: Provider) {
  const { Boxd } = await nativeModules.load("@boxd-sh/sdk");

  return new Boxd(connectionOf(provider, "boxd")).snapshots;
}

async function freestyleSnapshots(provider: Provider) {
  const { Freestyle } = await nativeModules.load("freestyle");
  const config = connectionOf(provider, "freestyle");

  return new Freestyle({ ...config, baseUrl: endpoint(config.baseUrl) }).vms.snapshots;
}

async function tenkiClient(provider: Provider) {
  const { TenkiSandbox } = await nativeModules.load("@tenkicloud/sandbox");

  return new TenkiSandbox(connectionOf(provider, "tenki"));
}

/**
 * Run `action` with a fresh Modal client on `provider`'s bound connection, closed afterwards.
 * Cleanup can outlive the adapter's client.
 */
async function withModal<T>(
  provider: Provider,
  action: (
    client: InstanceType<NativeModules["modal"]["ModalClient"]>,
    modal: NativeModules["modal"],
  ) => Promise<T>,
): Promise<T> {
  const params = modalClientParams(connectionOf(provider, "modal"));
  const modal = await nativeModules.load("modal");
  const client = new modal.ModalClient(params);

  try {
    return await action(client, modal);
  } finally {
    client.close();
  }
}

/** `@superserve/sdk` 0.11's transport: 3 attempts, 30 s each including the body, these statuses retried. */
const superserveAttempts = 3;
const superserveAttemptMs = 30_000;
const superserveRetryable: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** The SDK's backoff: 100 ms doubling per attempt, with ±20% jitter. */
const superserveBackoffMs = (attempt: number) =>
  100 * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Superserve's control plane on the key's region, with redirects refused: `@superserve/sdk` follows them,
 * and would send `X-API-Key` wherever one points. Otherwise it keeps the SDK's transport: each attempt,
 * body included, ends after 30 s or when `signal` aborts, and a 429, 502, 503, 504 or network error is
 * retried up to 3 attempts, after the SDK's backoff or a 429's `Retry-After` (at most 30 s).
 */
async function superserveFetch(
  provider: Provider,
  path: string,
  { method = "GET", signal }: { method?: "GET" | "DELETE"; signal?: AbortSignal } = {},
) {
  const { apiKey, baseUrl } = connectionOf(provider, "superserve");

  for (let attempt = 1; ; attempt++) {
    const attemptSignal = AbortSignal.any([
      AbortSignal.timeout(superserveAttemptMs),
      ...(signal ? [signal] : []),
    ]);

    let response: Response;

    try {
      response = await fetch(`${endpoint(baseUrl)}${path}`, {
        method,
        headers: { "X-API-Key": apiKey },
        redirect: "error",
        signal: attemptSignal,
      });
    } catch (error) {
      if (attemptSignal.aborted || attempt >= superserveAttempts || !(error instanceof TypeError))
        throw error;
      await pause(superserveBackoffMs(attempt), signal);
      continue;
    }

    if (!superserveRetryable.has(response.status) || attempt >= superserveAttempts) return response;
    const retryAfter = Number(response.headers.get("Retry-After") ?? Number.NaN);

    await response.body?.cancel();
    await pause(
      response.status === 429 && Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(retryAfter * 1000, 30_000)
        : superserveBackoffMs(attempt),
      signal,
    );
  }
}

/**
 * True when Superserve refused a snapshot delete because a sandbox still depends on it. Only the
 * error's code and message are matched, from at most 64 KiB of the answer; neither is kept.
 */
async function isSuperserveInUse(response: Response) {
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;

  try {
    while (reader && size <= 64 * 1024) {
      const { done, value } = await reader.read();

      if (done) break;
      parts.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }

  if (size > 64 * 1024) return false;
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    return false;
  }

  const fields = z.object({ code: z.string().optional(), message: z.string().optional() });
  const body = fields.extend({ error: fields.optional() }).safeParse(parsed);

  if (!body.success) return false;

  return [body.data.code, body.data.message, body.data.error?.code, body.data.error?.message].some(
    (text) => text !== undefined && /in.use|running sandbox|dependent sandbox/i.test(text),
  );
}

/**
 * Maritime's control plane through the adapter instance's connection. Snapshot calls never need the
 * source to be running.
 */
function maritimeFetch(provider: Provider, path: string, init: RequestInit = {}) {
  const { apiKey, baseUrl } = connectionOf(provider, "maritime");
  const headers = new Headers(init.headers);

  headers.set("Authorization", `Bearer ${apiKey}`);

  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  // Never follow a redirect: a write would be replayed as another request, and a read would
  // answer from somewhere other than the fingerprinted endpoint.
  return fetch(`${baseUrl}/v1${path}`, { ...init, headers, redirect: "error" });
}

/**
 * Styne's API through the adapter instance's connection. Snapshot calls never need the source
 * sandbox to be running.
 */
function styneFetch(provider: Provider, path: string, init: RequestInit = {}) {
  const { apiKey, baseUrl } = connectionOf(provider, "styne");
  const headers = new Headers(init.headers);

  headers.set("Authorization", `Bearer ${apiKey}`);

  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  // No call follows a redirect: a write would be replayed as another request, and a read would answer
  // for another resource, so a route's 404 could pass for a missing snapshot.
  return fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "error" });
}

/**
 * True only when Styne itself answered `404 not_found` about `target`; a route-level, undecodable or
 * foreign 404 is not absence.
 */
async function isStyneNotFound(response: Response, target: StyneTarget): Promise<boolean> {
  return response.status === 404 && (await styneErrorCode(response, target)) === "not_found";
}

function httpError(message: string, status: number) {
  return Object.assign(new Error(message), { status });
}

const maritimeSnapshot = z.object({ name: z.string(), sourceSandboxId: z.string().nullish() });

/**
 * A Maritime snapshot name the run picks before the save and journals with the source and the save's
 * idempotency key, so a save whose answer is lost still names the snapshot to settle and delete.
 */
export function maritimeSnapshotName(run: string) {
  const label = run
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 25);

  return `bench-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * `POST /v1/sandboxes/{id}/save` under a name and an idempotency key the run journaled before the request.
 * Only an answer naming this snapshot of this source counts; anything else throws, and the save is then
 * unsettled until {@link settleMaritimeSave} decides it.
 */
export async function createNamedMaritimeSnapshot(
  provider: Provider,
  sandboxId: string,
  name: string,
  idempotencyKey: string,
) {
  const response = await maritimeFetch(
    provider,
    `/sandboxes/${encodeURIComponent(sandboxId)}/save`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(600_000),
    },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw httpError("Maritime snapshot failed", response.status);
  }

  const saved = maritimeSnapshot.parse(await response.json());

  if (saved.name !== name || saved.sourceSandboxId !== sandboxId)
    throw new Error("Maritime snapshot answer names another snapshot or source");

  return { id: name };
}

const maritimeErrorBody = z.object({ code: z.string() });

async function readMaritimeErrorCode(response: Response): Promise<string | undefined> {
  const parsed = maritimeErrorBody.safeParse(await response.json().catch(() => null));

  return parsed.success ? parsed.data.code : undefined;
}

/** True only when Maritime explicitly confirmed the named snapshot does not exist. */
async function isMaritimeSnapshotNotFound(response: Response): Promise<boolean> {
  return (
    response.status === 404 && (await readMaritimeErrorCode(response)) === "snapshot_not_found"
  );
}

/** One read of a Maritime snapshot: absent only on `404 snapshot_not_found`, else its source, which must be this run's. */
async function readMaritimeSnapshot(
  provider: Provider,
  name: string,
  sandboxId: string,
  signal: AbortSignal,
) {
  const response = await maritimeFetch(provider, `/snapshots/${encodeURIComponent(name)}`, {
    signal,
  });

  if (response.status === 404) {
    if (await isMaritimeSnapshotNotFound(response)) return "absent" as const;
    throw httpError("Maritime snapshot read failed", response.status);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw httpError("Maritime snapshot read failed", response.status);
  }

  const snapshot = maritimeSnapshot.parse(await response.json());

  if (snapshot.name !== name || !snapshot.sourceSandboxId)
    throw new Error("Snapshot source metadata unavailable");

  if (snapshot.sourceSandboxId !== sandboxId)
    throw new Error("Snapshot source differs from recorded provenance; no deletion attempted");

  return "exists" as const;
}

/**
 * Whether a replay answer refused the save outright, so nothing was saved: an invalid request
 * (400, 422), `404 sandbox_not_found`, or `410 sandbox_ended`. A route-level `404 resource_not_found`,
 * auth failure (401, 403), conflict, rate limit or any 5xx says nothing about the first save.
 */
function isSaveRefusal(status: number, code: string | undefined): boolean {
  if (status === 400 || status === 422) return true;

  if (status === 404) return code === "sandbox_not_found";

  if (status === 410) return code === "sandbox_ended";

  return false;
}

/** A save the run journaled with its name, source and idempotency key, still to be settled. */
interface JournaledSave {
  provider: Provider;
  sandboxId: string;
  name: string;
  idempotencyKey: string;
  timeoutMs: number;
}

/**
 * Decides a save whose answer was lost, timed out or unreadable: whether its snapshot exists. `replay`
 * sends the journaled save again with the same idempotency key, which returns the first save's outcome
 * (or makes the save once), and says whether that answer refused the save outright; `read` then reads
 * the snapshot whatever the replay answered, so a snapshot that is already visible is found even when
 * the replay failed. An absent read is final only when the replay refused the save; otherwise it is read
 * again until the snapshot shows or the deadline passes, which throws and keeps the journal entry.
 */
async function settleSave(input: {
  label: string;
  timeoutMs: number;
  replay: (signal: AbortSignal) => Promise<boolean>;
  read: (signal: AbortSignal) => Promise<"exists" | "absent">;
}): Promise<"exists" | "absent"> {
  const end = Date.now() + input.timeoutMs;
  let backoffMs = 500;

  for (;;) {
    const left = end - Date.now();

    if (left <= 0)
      throw new Error(`${input.label} snapshot save did not settle; journal entry kept`);

    const refused = await input
      .replay(AbortSignal.timeout(Math.min(60_000, left)))
      .catch(() => false);

    const read = await input
      .read(AbortSignal.timeout(Math.max(1, Math.min(30_000, end - Date.now()))))
      .catch((cause: unknown) => {
        if (cause instanceof Error && /provenance|source metadata/.test(cause.message)) throw cause;

        return "unknown" as const;
      });

    if (read === "exists") return "exists";

    // A refused save made nothing. Any other save that does not show yet is read again.
    if (read === "absent" && refused) return "absent";

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(backoffMs, Math.max(0, end - Date.now()))),
    );
    backoffMs = Math.min(backoffMs * 2, 5000);
  }
}

/**
 * Decides a Maritime save whose answer was lost ({@link settleSave}). A `404 snapshot_not_found` read is
 * final only when the replay refused the save ({@link isSaveRefusal}).
 */
export function settleMaritimeSave(input: JournaledSave): Promise<"exists" | "absent"> {
  return settleSave({
    label: "Maritime",
    timeoutMs: input.timeoutMs,
    async replay(signal) {
      const response = await maritimeFetch(
        input.provider,
        `/sandboxes/${encodeURIComponent(input.sandboxId)}/save`,
        {
          method: "POST",
          headers: { "Idempotency-Key": input.idempotencyKey },
          body: JSON.stringify({ name: input.name }),
          signal,
        },
      );

      if (response.status === 404 || response.status === 410)
        return isSaveRefusal(response.status, await readMaritimeErrorCode(response));

      await response.body?.cancel();

      return isSaveRefusal(response.status, undefined);
    },
    read: (signal) => readMaritimeSnapshot(input.provider, input.name, input.sandboxId, signal),
  });
}

/**
 * Maritime's snapshots of one sandbox that this run journaled by name before saving them. The account's
 * list also has the stock templates and snapshots others saved; the run names its own before the request,
 * so nothing else is ever its to delete.
 */
async function snapshotsFromMaritimeSandbox(
  provider: Provider,
  sourceSandboxId: string,
  journaled: ReadonlySet<string>,
) {
  const found: { id: string; name: string }[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "100" });

    if (cursor !== null) query.set("cursor", cursor);

    const response = await maritimeFetch(provider, `/snapshots?${query}`);

    if (!response.ok) {
      await response.body?.cancel();
      throw httpError("Maritime snapshot listing failed", response.status);
    }

    const listing = z
      .object({ data: z.array(maritimeSnapshot), nextCursor: z.string().nullable() })
      .parse(await response.json());

    for (const snapshot of listing.data)
      if (snapshot.sourceSandboxId === sourceSandboxId && journaled.has(snapshot.name))
        found.push({ id: snapshot.name, name: snapshot.name });

    if (listing.nextCursor === null) return found;

    cursor = listing.nextCursor;
  }

  throw new Error("Snapshot recovery exceeded pagination bound");
}

/**
 * Providers whose snapshots the bench cannot delete. Their snapshot scenarios are skipped: a run
 * would leave every snapshot it made behind, and no cleaner can honestly report one removed.
 */
export const undeletableSnapshots: ReadonlyMap<string, string> = new Map([
  ["beam", "Beam has no API to delete a memory snapshot"],
]);

export async function snapshotCleaner(
  name: string,
  provider: Provider,
  sandboxId: string,
): Promise<(id: string, signal?: AbortSignal) => Promise<void>> {
  if (name === "instabox") {
    // A fresh request: cleanup can run after the source machine is gone.
    return async (id) => {
      const { apiKey, baseUrl } = connectionOf(provider, "instabox");

      // Never follow a redirect: it would replay the DELETE, key included, at another origin.
      const response = await fetch(`${baseUrl}/v1/snapshots/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": apiKey,
          "Idempotency-Key": crypto.randomUUID(),
          "X-Confirm-Delete": id,
        },
        redirect: "error",
      });

      if (!response.ok && response.status !== 404)
        throw Object.assign(new Error("Instabox snapshot delete failed"), {
          status: response.status,
        });
    };
  }

  if (name === "superserve") {
    return async (id, signal) => {
      const response = await superserveFetch(provider, `/snapshots/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal,
      });

      if ([400, 409, 423].includes(response.status) && (await isSuperserveInUse(response)))
        throw httpError("Superserve snapshot is in use by a dependent sandbox", response.status);

      await response.body?.cancel().catch(() => {});

      if (!response.ok && response.status !== 404)
        throw httpError("Superserve snapshot delete failed", response.status);
    };
  }

  if (microsandboxTier(name) !== undefined)
    // By managed ID, or by name for a capture journaled before it was answered; also after the source
    // sandbox is gone.
    return (id) => deleteMicrosandboxSnapshot(connectionOf(provider, "microsandbox"), id);

  if (name === "maritime") {
    // Deleted by name, also after the source sandbox has ended. Only `404 snapshot_not_found`
    // confirms absence; a route-level `404 resource_not_found` must fail so recovery retains it.
    return async (id) => {
      const response = await maritimeFetch(provider, `/snapshots/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });

      if (response.ok) {
        await response.body?.cancel();

        return;
      }

      if (response.status === 404) {
        if (await isMaritimeSnapshotNotFound(response)) return;
      } else {
        await response.body?.cancel();
      }

      throw httpError("Maritime snapshot delete failed", response.status);
    };
  }

  if (name === "styne") {
    // Deleted by name, also after the source sandbox is gone. Only Styne's `404 not_found` confirms
    // absence; a route-level or undecodable 404 must fail so recovery retains the snapshot.
    return async (id) => {
      const response = await styneFetch(provider, `/snapshots/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      if (response.ok) {
        await response.body?.cancel();

        return;
      }

      if (response.status === 404) {
        if (await isStyneNotFound(response, { sandboxId, snapshot: id })) return;
      } else {
        await response.body?.cancel();
      }

      throw httpError("Styne snapshot delete failed", response.status);
    };
  }

  if (name === "local") {
    const docker = localDocker(provider, sandboxId);

    return async (id) => {
      await docker.call("DELETE", `/images/${encodeURIComponent(id)}`);
    };
  }

  if (name === "boxd") {
    // A fresh client: cleanup can run after the source machine is gone, when the adapter's native handle is not.
    const snapshots = await boxdSnapshots(provider);

    return async (id) => {
      await snapshots.delete(id);
    };
  }

  if (name === "upstash") {
    const { Box } = await nativeModules.load("@upstash/box");

    return async (id) => {
      await Box.deleteSnapshots({ ...upstashConnection(provider), snapshotIds: [id] });
    };
  }

  if (name === "e2b") {
    const { Sandbox } = await nativeModules.load("e2b");

    return async (id) => {
      await Sandbox.deleteSnapshot(id, e2bConnection(provider));
    };
  }

  if (name === "daytona") {
    const snapshots = await daytonaSnapshots(provider);

    return async (id) => {
      await snapshots.delete(id);
    };
  }

  if (name === "freestyle") {
    const snapshots = await freestyleSnapshots(provider);

    return async (id) => {
      await snapshots.delete(id);
    };
  }

  if (name === "tenki") {
    const tenki = await tenkiClient(provider);

    return async (id) => {
      await tenki.deleteSnapshot(id);
    };
  }

  if (name === "modal")
    // A snapshot is a Modal Image. Its delete also succeeds for a missing image; inspect runs first.
    return (id) => withModal(provider, (client) => client.images.delete(id));

  if (name === "vercel") {
    const { Snapshot } = await nativeModules.load("@vercel/sandbox");

    return async (id) => {
      await (await Snapshot.get({ ...connectionOf(provider, "vercel"), snapshotId: id })).delete();
    };
  }

  throw new Error("Snapshot cleanup not registered");
}

/** The Daytona adapter's native handle, as far as snapshot creation uses it: `sdk()` returns the SDK sandbox. */
type DaytonaHandle = Pick<DaytonaNative, "sdk">;

/** Whether a native handle can reach the Daytona SDK sandbox. `Provider` erases the handle's type. */
function isDaytonaHandle(handle: unknown): handle is DaytonaHandle {
  return (
    typeof handle === "object" &&
    handle !== null &&
    "sdk" in handle &&
    typeof handle.sdk === "function"
  );
}

/** Name Daytona snapshots before creation for scoped timeout recovery; match the adapter's ten-minute completion budget. */
export async function createNamedDaytonaSnapshot(
  provider: Provider,
  sandboxId: string,
  name: string,
) {
  const handle = provider.native(sandboxId);

  if (!isDaytonaHandle(handle)) throw new Error("Daytona native handle unavailable");

  const sandbox = await handle.sdk(() => nativeModules.load("@daytonaio/sdk"));
  await sandbox.createSnapshot(name, 600);

  return { id: name };
}

const styneSnapshot = z.object({ name: z.string(), sandboxID: z.string().nullish() });

/**
 * A Styne snapshot under a name and an idempotency key the run journaled before the request, so a lost
 * answer still names the snapshot, and {@link settleStyneSave} can replay the save to decide it. The name
 * is the snapshot's portable ID. Only an answer naming this snapshot of this source confirms the save;
 * anything else throws, and the save is then unsettled until {@link settleStyneSave} decides it.
 */
export async function createNamedStyneSnapshot(
  provider: Provider,
  sandboxId: string,
  name: string,
  idempotencyKey: string = crypto.randomUUID(),
) {
  const response = await styneFetch(
    provider,
    `/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ name }),
    },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw httpError("Styne snapshot failed", response.status);
  }

  const saved = styneSnapshot.parse(await response.json());

  if (saved.name !== name || saved.sandboxID !== sandboxId)
    throw new Error("Styne snapshot answer names another snapshot or source");

  return { id: name };
}

/** One read of a Styne snapshot: absent only on `404 not_found`, else its source, which must be this run's. */
async function readStyneSnapshot(
  provider: Provider,
  name: string,
  sandboxId: string,
  signal: AbortSignal,
) {
  const response = await styneFetch(provider, `/snapshots/${encodeURIComponent(name)}`, { signal });

  if (response.status === 404) {
    if (await isStyneNotFound(response, { sandboxId, snapshot: name })) return "absent" as const;
    throw httpError("Styne snapshot read failed", response.status);
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw httpError("Styne snapshot read failed", response.status);
  }

  const snapshot = styneSnapshot.parse(await response.json());

  if (snapshot.name !== name || !snapshot.sandboxID)
    throw new Error("Snapshot source metadata unavailable");

  if (snapshot.sandboxID !== sandboxId)
    throw new Error("Snapshot source differs from recorded provenance; no deletion attempted");

  return "exists" as const;
}

/**
 * Whether a replayed Styne save refused it outright, so nothing was saved: an invalid request (400, 422),
 * `404 not_found` for the source, or a 410 with an ended code, each from a body that names no other
 * sandbox or snapshot ({@link styneErrorCode}). A route-level or foreign 404 or 410, auth failure (401,
 * 403), conflict, rate limit or any 5xx says nothing about the first save.
 */
function isStyneSaveRefusal(status: number, code: string | undefined): boolean {
  if (status === 400 || status === 422) return true;

  if (status === 404) return code === "not_found";

  if (status === 410) return code !== undefined && styneEnded.has(code);

  return false;
}

/**
 * Decides a Styne save whose answer was lost ({@link settleSave}). A `404 not_found` read is final only
 * when the replay refused the save ({@link isStyneSaveRefusal}).
 */
function settleStyneSave(input: JournaledSave): Promise<"exists" | "absent"> {
  return settleSave({
    label: "Styne",
    timeoutMs: input.timeoutMs,
    async replay(signal) {
      const response = await styneFetch(
        input.provider,
        `/sandboxes/${encodeURIComponent(input.sandboxId)}/snapshots`,
        {
          method: "POST",
          headers: { "Idempotency-Key": input.idempotencyKey },
          body: JSON.stringify({ name: input.name }),
          signal,
        },
      );

      if (response.status === 404 || response.status === 410)
        return isStyneSaveRefusal(
          response.status,
          await styneErrorCode(response, { sandboxId: input.sandboxId, snapshot: input.name }),
        );

      await response.body?.cancel();

      return isStyneSaveRefusal(response.status, undefined);
    },
    read: (signal) => readStyneSnapshot(input.provider, input.name, input.sandboxId, signal),
  });
}

/**
 * Styne's snapshots of one sandbox that this run journaled by name before creating them. Styne lists every
 * snapshot of the source, also after the sandbox is gone, and an operator may have saved one there too;
 * the run names its own before the request, so nothing else is ever its to delete.
 */
async function snapshotsFromStyneSandbox(
  provider: Provider,
  sourceSandboxId: string,
  journaled: ReadonlySet<string>,
) {
  const response = await styneFetch(
    provider,
    `/sandboxes/${encodeURIComponent(sourceSandboxId)}/snapshots`,
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw httpError("Styne snapshot listing failed", response.status);
  }

  return z
    .array(z.object({ name: z.string(), sandboxID: z.string() }))
    .parse(await response.json())
    .filter((snapshot) => snapshot.sandboxID === sourceSandboxId && journaled.has(snapshot.name))
    .map((snapshot) => ({ id: snapshot.name, name: snapshot.name }));
}

/** Narrow recovery query for snapshots of a sandbox whose run ownership was already established. */
export async function snapshotsFromDaytonaSandbox(provider: Provider, sourceSandboxId: string) {
  const snapshots = await daytonaSnapshots(provider);

  const pageSchema = z.object({
    items: z.array(z.object({ id: z.string(), name: z.string() })),
    totalPages: z.number(),
  });

  const items: { id: string; name: string }[] = [];

  for (let page = 1; page <= 100; page++) {
    const data = pageSchema.parse(await snapshots.list({ sourceSandboxId, page, limit: 100 }));
    items.push(...data.items);

    if (page >= data.totalPages) return items;
  }

  throw new Error("Snapshot recovery exceeded pagination bound");
}

/**
 * Query only a source sandbox already recorded in the run ownership journal. `journaled` is the snapshot
 * IDs the journal holds for that source; providers whose names the run picks before saving (Maritime, Styne)
 * keep only those.
 */
export async function snapshotsFromSource(
  name: string,
  provider: Provider,
  sourceSandboxId: string,
  journaled: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
) {
  if (name === "styne") return snapshotsFromStyneSandbox(provider, sourceSandboxId, journaled);

  if (name === "maritime")
    return snapshotsFromMaritimeSandbox(provider, sourceSandboxId, journaled);

  if (microsandboxTier(name) !== undefined)
    return microsandboxSnapshotsFromSource(
      connectionOf(provider, "microsandbox"),
      sourceSandboxId,
      journaled,
    );

  if (name !== "superserve") return snapshotsFromDaytonaSandbox(provider, sourceSandboxId);

  const response = await superserveFetch(
    provider,
    `/sandboxes/${encodeURIComponent(sourceSandboxId)}/snapshots`,
    { signal },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw httpError("Snapshot listing unavailable", response.status);
  }

  return z
    .array(z.object({ id: z.string(), name: z.string().nullish() }))
    .parse(await response.json())
    .map(({ id, name }): { id: string; name?: string } => (name ? { id, name } : { id }));
}

const snapshotInfo = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  sourceSandboxId: z.string().nullish(),
  sandboxId: z.string().nullish(),
  sessionId: z.string().nullish(),
  sourceVmId: z.string().nullish(),
  box_id: z.string().nullish(),
  sourceMachineId: z.string().nullish(),
});

type SnapshotInfo = z.infer<typeof snapshotInfo>;

/** Read snapshot metadata without connecting to, activating, or requiring a live source sandbox. */
export async function inspectSnapshot(
  name: string,
  provider: Provider,
  sourceId: string,
  id: string,
  signal?: AbortSignal,
): Promise<{ exists: boolean; sourceId?: string }> {
  // Microsandbox: by managed ID or name. The source is the snapshot's own `sandbox_id`, or the adapter's
  // source label; a snapshot that records neither is never attributed to anyone.
  if (microsandboxTier(name) !== undefined) {
    const snapshot = await readMicrosandboxSnapshot(connectionOf(provider, "microsandbox"), id);

    // Only an exact managed-ID read proves absence. A by-name 404 means only that the name is not
    // indexed (an unresolved capture, or one whose name lookup lags its managed ID), so it keeps the entry.
    if (snapshot === undefined) {
      if (!isMicrosandboxSnapshotId(id))
        throw new Error(
          "Snapshot not found by name; its managed ID is unknown, so the entry is kept",
        );

      return { exists: false };
    }

    if (capturedFrom(snapshot, sourceId)) return { exists: true, sourceId };
    const recorded = recordedSource(snapshot);

    if (recorded === undefined) throw new Error("Snapshot source metadata unavailable");

    return { exists: true, sourceId: recorded };
  }

  try {
    let info: SnapshotInfo;

    switch (name) {
      case "e2b": {
        const { Sandbox } = await nativeModules.load("e2b");
        const page = Sandbox.listSnapshots({ ...e2bConnection(provider), name: id, limit: 100 });

        for (let index = 0; index < 100; index++) {
          const items = z.array(z.object({ snapshotId: z.string() })).parse(await page.nextItems());

          if (items.some((item) => item.snapshotId === id)) return { exists: true };

          if (page.hasNext === false || !items.length)
            throw new Error("Snapshot metadata not visible; absence unproven");
        }

        throw new Error("Snapshot metadata pagination exhausted");
      }

      case "daytona": {
        const snapshots = await daytonaSnapshots(provider);

        info = snapshotInfo.parse(await snapshots.get(id));
        break;
      }

      case "boxd": {
        const snapshots = await boxdSnapshots(provider);

        info = snapshotInfo.parse(await snapshots.get(id));
        break;
      }

      case "tenki": {
        const tenki = await tenkiClient(provider);

        info = snapshotInfo.parse(await tenki.getSnapshot(id));
        break;
      }

      case "freestyle": {
        const snapshots = await freestyleSnapshots(provider);

        info = snapshotInfo.parse(await snapshots.get(id));
        break;
      }

      case "instabox": {
        const { apiKey, baseUrl } = connectionOf(provider, "instabox");

        const response = await fetch(`${baseUrl}/v1/snapshots/${encodeURIComponent(id)}`, {
          headers: { "X-API-Key": apiKey },
          redirect: "error",
        });

        if (!response.ok)
          throw Object.assign(new Error("Snapshot metadata unavailable"), {
            status: response.status,
          });
        info = snapshotInfo.parse(await response.json());
        break;
      }

      case "superserve": {
        const response = await superserveFetch(provider, `/snapshots/${encodeURIComponent(id)}`, {
          signal,
        });

        if (!response.ok) {
          await response.body?.cancel();
          throw httpError("Snapshot metadata unavailable", response.status);
        }

        const snapshot = z
          .object({ id: z.string(), name: z.string().nullish(), sandbox_id: z.string().nullish() })
          .parse(await response.json());

        info = {
          id: snapshot.id,
          name: snapshot.name ?? undefined,
          sandboxId: snapshot.sandbox_id,
        };
        break;
      }

      case "styne": {
        const response = await styneFetch(provider, `/snapshots/${encodeURIComponent(id)}`);

        // Only Styne's own `404 not_found` is absence; a route-level or undecodable 404 is unavailable.
        if (response.status === 404) {
          if (await isStyneNotFound(response, { sandboxId: sourceId, snapshot: id }))
            return { exists: false };
          throw httpError("Snapshot metadata unavailable", response.status);
        }

        if (!response.ok) {
          await response.body?.cancel();
          throw httpError("Snapshot metadata unavailable", response.status);
        }

        // Styne names the source `sandboxID`; the shared schema reads `sandboxId`.
        const styne = styneSnapshot.parse(await response.json());

        info = { name: styne.name, sandboxId: styne.sandboxID };
        break;
      }

      case "maritime": {
        const response = await maritimeFetch(provider, `/snapshots/${encodeURIComponent(id)}`);

        if (response.status === 404) {
          if (await isMaritimeSnapshotNotFound(response)) return { exists: false };
          throw httpError("Snapshot metadata unavailable", response.status);
        }

        if (!response.ok) {
          await response.body?.cancel();
          throw httpError("Snapshot metadata unavailable", response.status);
        }

        // Only Maritime's own `sourceSandboxId` proves the source; no other field stands in for it.
        const snapshot = maritimeSnapshot.parse(await response.json());

        if (snapshot.name !== id) throw new Error("Snapshot metadata ID mismatch");

        if (!snapshot.sourceSandboxId) throw new Error("Snapshot source metadata unavailable");

        return { exists: true, sourceId: snapshot.sourceSandboxId };
      }

      case "upstash": {
        const { apiKey, baseUrl } = connectionOf(provider, "upstash");

        const response = await fetch(`${baseUrl}/v2/box/snapshots`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        // An account-wide listing says nothing about this snapshot when it fails, a 404 included:
        // the error carries no status, so it is unavailable, never absence.
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Snapshot listing unavailable (HTTP ${response.status})`);
        }

        const list = z.object({ snapshots: z.array(snapshotInfo) }).parse(await response.json());
        const listed = list.snapshots.find((snapshot) => snapshot.id === id);

        if (!listed) throw new Error("Snapshot metadata not visible; absence unproven");
        info = listed;
        break;
      }

      case "modal": {
        // Modal Images record no source sandbox, so provenance rests on the ownership journal.
        const found = await withModal(provider, async (client, modal) => {
          try {
            if ((await client.images.fromId(id)).imageId !== id)
              throw new Error("Snapshot metadata ID mismatch");

            return true;
          } catch (error) {
            if (error instanceof modal.NotFoundError) return false;
            throw error;
          }
        });

        return { exists: found };
      }

      case "vercel": {
        // Vercel keeps a deleted snapshot readable with status "deleted". Its source is a session
        // ID, not the sandbox name the ownership proof records, so no parent is compared.
        const { Snapshot } = await nativeModules.load("@vercel/sandbox");

        const snapshot = await Snapshot.get({
          ...connectionOf(provider, "vercel"),
          snapshotId: id,
        });

        if (snapshot.snapshotId !== id) throw new Error("Snapshot metadata ID mismatch");

        return { exists: snapshot.status !== "deleted" };
      }

      case "local": {
        const docker = localDocker(provider, sourceId);

        z.object({ Id: z.string() }).parse(
          await docker.call("GET", `/images/${encodeURIComponent(id)}/json`),
        );

        return { exists: true };
      }

      default:
        throw new Error("Native snapshot metadata unavailable");
    }

    if (info.id !== id && info.name !== id) throw new Error("Snapshot metadata ID mismatch");

    const parent =
      info.sourceSandboxId ??
      info.sandboxId ??
      info.sessionId ??
      info.sourceVmId ??
      info.box_id ??
      info.sourceMachineId;

    // These APIs expose provenance: unreadable or cleared source fields cannot authorize deletion.
    if (
      ["daytona", "superserve", "tenki", "freestyle", "upstash", "instabox", "styne"].includes(
        name,
      ) &&
      !parent
    )
      throw new Error("Snapshot source metadata unavailable");

    if (!parent) return { exists: true };

    return { exists: true, sourceId: parent };
  } catch (error) {
    if (
      name !== "maritime" &&
      name !== "styne" &&
      lookupError(error, name, `${name}:snapshot-exact-get`).result === "not-found"
    )
      return { exists: false };
    throw error;
  }
}

export const snapshotMetadata = { inspect: inspectSnapshot };

/**
 * A settled journal entry. `exists` names the snapshot the proven delete must use: the entry's own ID,
 * or for a Microsandbox capture journaled by name, the managed ID settlement confirmed.
 */
export type JournaledSnapshot = { kind: "exists"; id: string } | { kind: "absent" };

/**
 * Before a journaled snapshot entry is deleted or forgotten: a Maritime or Styne entry that still holds its
 * save's idempotency key is a save that never confirmed, so it is settled first ({@link settleMaritimeSave},
 * {@link settleStyneSave}). `absent` means nothing was saved and the entry may go; `exists` (or any other
 * entry) proceeds to the proven delete of the snapshot it names. An unsettled save throws, and the entry stays for recovery.
 */
export async function settleJournaledSnapshot(
  name: string,
  provider: Provider,
  entry: { id: string; parent: string | null; idempotencyKey?: string; snapshotName?: string },
  timeoutMs: number,
): Promise<JournaledSnapshot> {
  // Microsandbox: a capture journaled by name before its request, never confirmed. Settled through the
  // snapshot and its operation, keeping the managed ID it finds; an unresolved 404 throws and keeps the entry.
  if (microsandboxTier(name) !== undefined && entry.snapshotName === entry.id) {
    const capture = await settleMicrosandboxCapture(
      connectionOf(provider, "microsandbox"),
      entry.id,
      timeoutMs,
    );

    return capture.kind === "exists" ? { kind: "exists", id: capture.managedId } : capture;
  }

  if ((name !== "maritime" && name !== "styne") || entry.idempotencyKey === undefined)
    return { kind: "exists", id: entry.id };

  if (entry.parent === null) throw new Error("Snapshot source missing; no deletion attempted");

  const save = {
    provider,
    sandboxId: entry.parent,
    name: entry.id,
    idempotencyKey: entry.idempotencyKey,
    timeoutMs,
  };

  const saved = await (name === "maritime" ? settleMaritimeSave(save) : settleStyneSave(save));

  return saved === "exists" ? { kind: "exists", id: entry.id } : { kind: "absent" };
}

/** A durable source proof plus current snapshot identity replaces a live-parent dependency. */
export async function deleteProvenSnapshot(
  name: string,
  provider: Provider,
  id: string,
  parent: string | null,
  proof: SnapshotProvenance | undefined,
  run: string,
  timeoutMs: number,
  cleaner?: (id: string, signal?: AbortSignal) => Promise<void>,
) {
  const valid = snapshotProvenanceSchema.safeParse(proof);

  if (!valid.success || valid.data.sourceId !== parent || valid.data.runLabel !== run)
    throw new Error("Recorded snapshot provenance missing or mismatched; no deletion attempted");
  const end = performance.now() + Math.min(timeoutMs, 30000);
  let backoffMs = 100;

  for (;;) {
    const remaining = end - performance.now();

    if (remaining <= 0) throw new Error("Snapshot cleanup retry budget exhausted");

    const live = await deadline(remaining, (signal) =>
      snapshotMetadata.inspect(name, provider, valid.data.sourceId, id, signal),
    );

    if (!live.exists) return;

    if (live.sourceId !== undefined && live.sourceId !== valid.data.sourceId)
      throw new Error("Snapshot source differs from recorded provenance; no deletion attempted");
    const remove = cleaner ?? (await snapshotCleaner(name, provider, valid.data.sourceId));

    try {
      await deadline(Math.max(1, end - performance.now()), (signal) => remove(id, signal));

      return;
    } catch (error) {
      const status = z
        .object({
          status: z.number().optional(),
          statusCode: z.number().optional(),
          response: z.object({ status: z.number() }).optional(),
        })
        .safeParse(error);

      const http = status.success
        ? (status.data.status ?? status.data.statusCode ?? status.data.response?.status)
        : undefined;

      const message = error instanceof Error ? error.message : "";

      if (
        ![400, 409, 423].includes(http ?? 0) ||
        !/in.use|running sandbox|still.*(?:use|sandbox)|dependent sandbox/i.test(message)
      )
        throw error;
      const left = end - performance.now();

      if (left <= 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, left)));
      backoffMs = Math.min(backoffMs * 2, 2000);
    }
  }
}

import { z } from "zod";
import type { DaytonaNative } from "@opencoredev/sandbox-sdk/daytona";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import {
  agent37Ending,
  agent37ErrorCode,
  agent37Instance,
  agent37InstanceList,
  agent37SnapshotLabel,
  buddyErrors,
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
import { buddyWorkspaceApi, connectionOf, endpoint, modalClientParams } from "./connections.js";
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
 * Agent 37's control plane through the adapter instance's connection. An adapter snapshot is an
 * instance (a stopped fork), so every snapshot call is an instance call.
 */
function agent37Fetch(provider: Provider, path: string, init: RequestInit = {}) {
  const { apiKey, baseUrl } = connectionOf(provider, "agent37");
  const headers = new Headers(init.headers);

  headers.set("Authorization", `Bearer ${apiKey}`);

  // Never follow a redirect: a DELETE would be replayed at another origin, and a read would answer
  // from somewhere other than the fingerprinted endpoint.
  return fetch(`${baseUrl}/v1${path}`, { ...init, headers, redirect: "error" });
}

/**
 * One instance as a snapshot: `absent` only on Agent 37's own `404 not_found` or a delete already
 * accepted; otherwise the instance with the source its snapshot marker names, if it has one.
 */
async function readAgent37Snapshot(
  provider: Provider,
  id: string,
  signal?: AbortSignal,
): Promise<{ kind: "absent" } | { kind: "instance"; sourceId: string | undefined }> {
  const response = await agent37Fetch(provider, `/instances/${encodeURIComponent(id)}`, { signal });

  if (response.status === 404) {
    if ((await agent37ErrorCode(response)) === "not_found") return { kind: "absent" };
    throw new Error("Agent 37 snapshot read answered an unknown 404");
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw httpError("Snapshot metadata unavailable", response.status);
  }

  const instance = agent37Instance.parse(await response.json());

  if (instance.id !== id) throw new Error("Snapshot metadata ID mismatch");

  if (agent37Ending.has(instance.status)) return { kind: "absent" };
  const source = z.string().min(1).safeParse(instance.metadata?.[agent37SnapshotLabel]);

  return { kind: "instance", sourceId: source.success ? source.data : undefined };
}

/** The adapter snapshots of one source: instances whose snapshot marker names it, deletes not yet accepted. */
async function snapshotsFromAgent37Sandbox(
  provider: Provider,
  sourceSandboxId: string,
  signal?: AbortSignal,
) {
  const response = await agent37Fetch(provider, "/instances", { signal });

  if (!response.ok) {
    await response.body?.cancel();
    throw httpError("Agent 37 instance listing failed", response.status);
  }

  return agent37InstanceList
    .parse(await response.json())
    .data.filter(
      (instance) =>
        instance.metadata?.[agent37SnapshotLabel] === sourceSandboxId &&
        !agent37Ending.has(instance.status),
    )
    .map((instance): Pick<JournaledSnapshotEntry, "id" | "name"> => ({ id: instance.id }));
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
 * Buddy's workspace API through the adapter instance's connection. Snapshot reads and deletes never need
 * the source running. No call follows a redirect: a write would be replayed, token included, at another
 * origin, and a read would answer for another resource.
 */
function buddyFetch(provider: Provider, path: string, init: RequestInit = {}) {
  const config = connectionOf(provider, "buddy");
  const headers = new Headers(init.headers);

  headers.set("Authorization", `Bearer ${config.token}`);

  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  return fetch(`${buddyWorkspaceApi(config)}${path}`, { ...init, headers, redirect: "error" });
}

const buddySnapshot = z.object({
  id: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  url: z.string().optional(),
});

type BuddySnapshot = z.infer<typeof buddySnapshot>;

const buddySnapshotList = z.object({ snapshots: z.array(buddySnapshot).optional() });

/** Whether a Buddy 404 says the resource is missing (`Resource not found`), not some other failure. */
async function isBuddyMissing(response: Response): Promise<boolean> {
  if (response.status !== 404) return false;
  const body = buddyErrors.safeParse(await response.json().catch(() => null));

  return body.success && body.data.errors[0]?.message === "Resource not found";
}

/** The source sandbox a Buddy snapshot's API URL names; undefined once the source is deleted. */
function sourceOf(snapshot: BuddySnapshot): string | undefined {
  const match = /\/sandboxes\/([^/]+)\/snapshots\//.exec(snapshot.url ?? "")?.[1];

  return match === undefined ? undefined : decodeURIComponent(match);
}

/** Whether a snapshot can be the source's: its URL names that source, or no source at all. */
const fromSource = (snapshot: BuddySnapshot, sourceId: string) => {
  const named = sourceOf(snapshot);

  return named === undefined || named === sourceId;
};

/**
 * A snapshot name the run picks before the save and journals with the source, for providers whose save
 * the run names (Maritime, Buddy), so a save whose answer is lost still names the snapshot to settle.
 */
export function journaledSnapshotName(run: string) {
  return maritimeSnapshotName(run);
}

/**
 * `POST /sandboxes/{id}/snapshots` under a name the run journaled before the request. Only an answer
 * naming this snapshot counts; `onSaved` gets its ID at once, so the run journals it before it waits for
 * the snapshot to be `CREATED` (or deletes anything). A 4xx answer is a refusal: it carries `refused`.
 */
export async function createNamedBuddySnapshot(
  provider: Provider,
  sandboxId: string,
  name: string,
  onSaved: (id: string) => Promise<void>,
) {
  const response = await buddyFetch(
    provider,
    `/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`,
    {
      method: "POST",
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(httpError("Buddy snapshot failed", response.status), {
      refused:
        response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status),
    });
  }

  const saved = buddySnapshot.parse(await response.json());

  if (saved.name !== name) throw new Error("Buddy snapshot answer names another snapshot");
  await onSaved(saved.id);

  const end = Date.now() + 600_000;
  let transientMisses = 0;

  for (let status = saved.status; status !== "CREATED";) {
    if (status === "FAILED" || status === "DELETING")
      throw new Error(`Buddy snapshot ${saved.id} is ${status}`);

    if (Date.now() > end) throw new Error("Buddy snapshot was not created in ten minutes");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const read = await buddyFetch(
      provider,
      `/sandboxes/${encodeURIComponent(sandboxId)}/snapshots/${encodeURIComponent(saved.id)}`,
      { signal: AbortSignal.timeout(30_000) },
    );

    if (!read.ok) {
      await read.body?.cancel();

      // Buddy can briefly return 404 right after snapshot creation; retry a few times like the SDK.
      if (read.status === 404 && transientMisses < 5 && Date.now() <= end) {
        transientMisses++;
        continue;
      }

      throw httpError("Buddy snapshot read failed", read.status);
    }

    transientMisses = 0;
    status = buddySnapshot.parse(await read.json()).status;
  }

  return { id: saved.id };
}

/**
 * The snapshots named `name`: from the source's own list while it exists, and from the workspace's list,
 * which keeps a snapshot after its source is deleted. `sourceGone` is true only on Buddy's
 * `404 Resource not found` for the source.
 */
async function buddySnapshotsNamed(
  provider: Provider,
  sourceId: string,
  name: string,
  signal: AbortSignal,
) {
  const source = await buddyFetch(
    provider,
    `/sandboxes/${encodeURIComponent(sourceId)}/snapshots`,
    {
      signal,
    },
  );

  let sourceGone = false;
  const sourceFound = new Map<string, BuddySnapshot>();
  const allFound = new Map<string, BuddySnapshot>();

  if (source.ok) {
    for (const s of buddySnapshotList.parse(await source.json()).snapshots ?? [])
      if (s.name === name) {
        sourceFound.set(s.id, s);
        allFound.set(s.id, s);
      }
  } else if (await isBuddyMissing(source)) sourceGone = true;
  else throw httpError("Buddy snapshot listing failed", source.status);

  const workspace = await buddyFetch(provider, "/sandboxes/snapshots", { signal });

  if (!workspace.ok) {
    await workspace.body?.cancel();
    throw httpError("Buddy snapshot listing failed", workspace.status);
  }

  for (const s of buddySnapshotList.parse(await workspace.json()).snapshots ?? [])
    if (s.name === name) allFound.set(s.id, s);

  if (allFound.size > 1) return { found: [...allFound.values()], sourceGone };

  const [only] = allFound.values();

  if (!only) return { found: [], sourceGone };

  if (!sourceGone && !sourceFound.has(only.id) && sourceOf(only) !== sourceId)
    return { found: [], sourceGone };

  if (!fromSource(only, sourceId)) return { found: [], sourceGone };

  return { found: [only], sourceGone };
}

/** How long after it was journaled a Buddy save that has not shown can still land. */
export const buddySaveWindowMs = 10 * 60_000;

/**
 * Decides a Buddy save whose answer was lost, timed out or unreadable, by the exact name journaled before
 * it: `exists` with the snapshot's ID once a list shows that name, `absent` only when two reads at least
 * five seconds apart both miss it and the save can no longer land (its source is gone, or the journal entry
 * is older than {@link buddySaveWindowMs}). A single miss never settles it; when the deadline passes first,
 * this throws and the journal entry stays for recovery.
 */
export async function settleBuddySave(input: {
  provider: Provider;
  sandboxId: string;
  name: string;
  journaledAt: string;
  timeoutMs: number;
}): Promise<JournaledSnapshot> {
  const end = Date.now() + input.timeoutMs;
  let firstMiss: number | undefined;

  for (;;) {
    const left = end - Date.now();

    if (left <= 0) throw new Error("Buddy snapshot save did not settle; journal entry kept");

    const read = await buddySnapshotsNamed(
      input.provider,
      input.sandboxId,
      input.name,
      AbortSignal.timeout(Math.max(1, Math.min(30_000, left))),
    ).catch(() => undefined);

    if (read && read.found.length > 1)
      throw new Error("Several Buddy snapshots carry the journaled name; none deleted");

    const [hit] = read?.found ?? [];

    if (hit) return { kind: "exists", id: hit.id };

    if (read) {
      const settled =
        read.sourceGone || Date.now() - Date.parse(input.journaledAt) > buddySaveWindowMs;

      if (settled && firstMiss !== undefined && Date.now() - firstMiss >= 5000)
        return { kind: "absent" };

      if (settled) firstMiss ??= Date.now();
    }

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(2000, Math.max(0, end - Date.now()))),
    );
  }
}

/**
 * Which listed Buddy snapshots are the journal's own, by exact identity. A confirmed entry matches only
 * the snapshot with its ID AND its journaled name: an ID whose name now differs is not proof, and the
 * entry is left for its own check, which refuses it. A pending save matches the one snapshot carrying
 * its journaled name; two or more with that name are ambiguous and match nothing, so none is deleted on
 * a name alone. Each match carries the journal's name, never the live one.
 */
export function ownedBuddySnapshots(
  listed: readonly { id: string; name?: string }[],
  journaled: readonly JournaledSnapshotEntry[],
): { id: string; name: string }[] {
  const found = new Map<string, { id: string; name: string }>();

  for (const entry of journaled) {
    const pending = entry.pendingSave?.name;

    if (pending !== undefined) {
      const named = listed.filter((s) => s.name === pending);
      const [only] = named;

      if (only && named.length === 1) found.set(only.id, { id: only.id, name: pending });
      continue;
    }

    const hit = listed.find((s) => s.id === entry.id);

    if (hit && entry.name !== undefined && hit.name === entry.name)
      found.set(hit.id, { id: hit.id, name: entry.name });
  }

  return [...found.values()];
}

/** Buddy snapshots of one source that the journal holds, by exact ID and name or a pending save's name. */
async function snapshotsFromBuddySandbox(
  provider: Provider,
  sourceSandboxId: string,
  journaled: readonly JournaledSnapshotEntry[],
  signal?: AbortSignal,
) {
  const init = signal ? { signal } : {};

  const source = await buddyFetch(
    provider,
    `/sandboxes/${encodeURIComponent(sourceSandboxId)}/snapshots`,
    init,
  );

  if (source.ok) {
    const sourceItems = buddySnapshotList.parse(await source.json()).snapshots ?? [];
    const hasPending = journaled.some((entry) => entry.pendingSave !== undefined);

    if (!hasPending) return ownedBuddySnapshots(sourceItems, journaled);

    // Check the workspace inventory too so a pending name duplicated outside the source list is
    // treated as ambiguous and never deleted on name alone.
    const workspace = await buddyFetch(provider, "/sandboxes/snapshots", init);

    if (!workspace.ok) {
      await workspace.body?.cancel();
      throw httpError("Buddy snapshot listing failed", workspace.status);
    }

    const workspaceItems = buddySnapshotList.parse(await workspace.json()).snapshots ?? [];
    const duplicatedNames = new Set<string>();
    const idsByName = new Map<string, Set<string>>();

    for (const item of [...sourceItems, ...workspaceItems]) {
      if (item.name === undefined) continue;
      let ids = idsByName.get(item.name);

      if (!ids) {
        ids = new Set();
        idsByName.set(item.name, ids);
      }

      ids.add(item.id);

      if (ids.size > 1) duplicatedNames.add(item.name);
    }

    return ownedBuddySnapshots(
      sourceItems,
      journaled.filter(
        (entry) => entry.pendingSave === undefined || !duplicatedNames.has(entry.pendingSave.name),
      ),
    );
  }

  if (!(await isBuddyMissing(source)))
    throw httpError("Buddy snapshot listing failed", source.status);

  // The source is gone: the workspace list keeps its snapshots, without the source in their URL.
  const workspace = await buddyFetch(provider, "/sandboxes/snapshots", init);

  if (!workspace.ok) {
    await workspace.body?.cancel();
    throw httpError("Buddy snapshot listing failed", workspace.status);
  }

  const allWorkspace = buddySnapshotList.parse(await workspace.json()).snapshots ?? [];
  const matches = ownedBuddySnapshots(allWorkspace, journaled);
  const byId = new Map(allWorkspace.map((s) => [s.id, s]));

  return matches.filter((m) => {
    const full = byId.get(m.id);

    return full !== undefined && fromSource(full, sourceSandboxId);
  });
}

/**
 * Providers whose snapshots the bench cannot delete. Their snapshot scenarios are skipped: a run
 * would leave every snapshot it made behind, and no cleaner can honestly report one removed.
 */
export const undeletableSnapshots: ReadonlyMap<string, string> = new Map([
  ["beam", "Beam has no API to delete a memory snapshot"],
]);

/**
 * A snapshot delete. `signal` ends it early; Buddy's also takes the name the journal holds for the
 * snapshot, and `beforeDelete`, which runs once every check has passed and just before the DELETE.
 */
export type SnapshotDelete = (
  id: string,
  signal?: AbortSignal,
  expectedName?: string,
  beforeDelete?: () => Promise<void>,
) => Promise<void>;

export async function snapshotCleaner(
  name: string,
  provider: Provider,
  sandboxId: string,
  expectedName?: string,
): Promise<SnapshotDelete> {
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

  if (name === "agent37") {
    // An instance delete, also after the source is gone: it ends the snapshot's disk billing. It is
    // sent only for an instance whose snapshot marker names this source, read just before the DELETE,
    // so no other instance is ever deleted as a snapshot.
    return async (id, signal) => {
      const read = await readAgent37Snapshot(provider, id, signal);

      if (read.kind === "absent") return;

      if (read.sourceId !== sandboxId)
        throw new Error("Instance is not a snapshot of this source; no deletion attempted");

      const response = await agent37Fetch(provider, `/instances/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal,
      });

      if (response.status === 404 && (await agent37ErrorCode(response)) === "not_found") return;

      await response.body?.cancel().catch(() => {});

      if (!response.ok) throw httpError("Agent 37 snapshot delete failed", response.status);
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

  if (name === "buddy") {
    // By ID on the workspace route, also after the source is deleted. A snapshot still `CREATING` is
    // waited for first. Only `404 Resource not found` on the delete confirms absence: a miss in the
    // workspace list, which can lag the source's, never does. Honors the caller's abort signal so an
    // expired cleanup never issues a late DELETE.
    return async (id, signal, callExpectedName, beforeDelete) => {
      const requiredName = callExpectedName ?? expectedName;

      const checkAborted = () => {
        if (signal?.aborted) throw new Error("Buddy snapshot cleanup timed out before delete");
      };

      const path = `/sandboxes/snapshots/${encodeURIComponent(id)}`;
      const end = Date.now() + 120_000;

      for (;;) {
        checkAborted();
        const list = await buddyFetch(provider, "/sandboxes/snapshots", signal ? { signal } : {});
        checkAborted();

        if (!list.ok) {
          await list.body?.cancel();
          throw httpError("Buddy snapshot listing failed", list.status);
        }

        const snapshot = (buddySnapshotList.parse(await list.json()).snapshots ?? []).find(
          (s) => s.id === id,
        );

        checkAborted();

        if (snapshot) {
          if (requiredName !== undefined && snapshot.name !== requiredName)
            throw new Error("Snapshot name differs from the journaled name; no deletion attempted");

          const listedSource = sourceOf(snapshot);

          if (listedSource !== undefined && listedSource !== sandboxId)
            throw new Error(
              "Snapshot source differs from recorded provenance; no deletion attempted",
            );
        }

        if (snapshot?.status !== "CREATING" || Date.now() > end) break;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          }, 1000);

          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Buddy snapshot cleanup timed out before delete"));
          };

          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
      }

      checkAborted();

      if (beforeDelete) {
        await beforeDelete();
        checkAborted();
      }

      const response = await buddyFetch(
        provider,
        path,
        signal ? { method: "DELETE", signal } : { method: "DELETE" },
      );

      if (response.ok || (await isBuddyMissing(response))) {
        await response.body?.cancel().catch(() => {});

        return;
      }

      await response.body?.cancel().catch(() => {});
      throw httpError("Buddy snapshot delete failed", response.status);
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
 * A snapshot entry the journal holds for one source: its ID, and for Buddy the name it was saved under,
 * or, while its save is pending, that save's name (its ID until the snapshot's ID is known).
 */
export interface JournaledSnapshotEntry {
  id: string;
  name?: string;
  pendingSave?: { name: string };
}

/** The journal's entries for a source, given as entries or as their IDs alone. */
function entriesOf(
  journaled: ReadonlySet<string> | readonly JournaledSnapshotEntry[],
): readonly JournaledSnapshotEntry[] {
  return "has" in journaled ? [...journaled].map((id) => ({ id })) : journaled;
}

/**
 * Query only a source sandbox already recorded in the run ownership journal. `journaled` is the snapshot
 * entries (or IDs) the journal holds for that source; providers whose names the run picks before saving
 * (Maritime, Styne, Buddy) keep only those, and Buddy only by exact identity ({@link ownedBuddySnapshots}).
 */
export async function snapshotsFromSource(
  name: string,
  provider: Provider,
  sourceSandboxId: string,
  journaled: ReadonlySet<string> | readonly JournaledSnapshotEntry[] = [],
  signal?: AbortSignal,
) {
  const entries = entriesOf(journaled);
  const ids: ReadonlySet<string> = new Set(entries.map((entry) => entry.id));

  if (name === "buddy")
    return snapshotsFromBuddySandbox(provider, sourceSandboxId, entries, signal);

  if (name === "styne") return snapshotsFromStyneSandbox(provider, sourceSandboxId, ids);

  // Agent 37's snapshot marker names its source, so every adapter snapshot of a run-owned source is found.
  if (name === "agent37") return snapshotsFromAgent37Sandbox(provider, sourceSandboxId, signal);

  if (name === "maritime") return snapshotsFromMaritimeSandbox(provider, sourceSandboxId, ids);

  if (microsandboxTier(name) !== undefined)
    return microsandboxSnapshotsFromSource(
      connectionOf(provider, "microsandbox"),
      sourceSandboxId,
      ids,
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

const buddyAbsenceUnproven = "Snapshot metadata not visible; absence unproven";

/**
 * A Buddy snapshot by exact ID: from the source's own list first while the source exists, then the
 * workspace list and Buddy's exact-ID snapshot route (`GET /sandboxes/{source}/snapshots/{id}`).
 * `undefined` only when the live source list and workspace list omit it AND the exact-ID endpoint
 * answers `404 Resource not found`; when the source is already gone, a miss in the workspace list
 * never proves absence (it can lag) and throws {@link buddyAbsenceUnproven} instead.
 */
async function buddySnapshotById(
  provider: Provider,
  sourceId: string,
  id: string,
  signal?: AbortSignal,
) {
  const init = signal ? { signal } : {};

  const source = await buddyFetch(
    provider,
    `/sandboxes/${encodeURIComponent(sourceId)}/snapshots`,
    init,
  );

  if (source.ok) {
    const listed = (buddySnapshotList.parse(await source.json()).snapshots ?? []).find(
      (s) => s.id === id,
    );

    if (listed) return { snapshot: listed, provenSourceId: sourceOf(listed) ?? sourceId };

    // Live source list answered cleanly without this snapshot. Check the workspace list so we never
    // mistake an unattributed workspace record for absence OR authorize deleting it without source proof.
    const workspace = await buddyFetch(provider, "/sandboxes/snapshots", init);

    if (!workspace.ok) {
      await workspace.body?.cancel();
      throw httpError("Snapshot metadata unavailable", workspace.status);
    }

    const wsListed = (buddySnapshotList.parse(await workspace.json()).snapshots ?? []).find(
      (s) => s.id === id,
    );

    if (!wsListed) {
      // Both lists can lag on a live source; only an exact-ID 404 proves absence.
      const exact = await buddyFetch(
        provider,
        `/sandboxes/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(id)}`,
        init,
      );

      if (exact.ok) {
        const snap = buddySnapshot.parse(await exact.json());

        if (snap.id !== id) throw new Error("Snapshot metadata ID mismatch");

        return { snapshot: snap, provenSourceId: sourceOf(snap) ?? sourceId };
      }

      if (await isBuddyMissing(exact)) {
        // A source-scoped 404 can mean the source sandbox vanished between the first list and this
        // GET, while the snapshot itself still survives in the workspace. Recheck the source list:
        // only if the source is still live (and still omits the snapshot) is absence proven.
        const recheck = await buddyFetch(
          provider,
          `/sandboxes/${encodeURIComponent(sourceId)}/snapshots`,
          init,
        );

        if (recheck.ok) {
          const again = (buddySnapshotList.parse(await recheck.json()).snapshots ?? []).find(
            (s) => s.id === id,
          );

          if (again) return { snapshot: again, provenSourceId: sourceOf(again) ?? sourceId };

          return undefined;
        }

        if (await isBuddyMissing(recheck)) throw new Error(buddyAbsenceUnproven);
        await recheck.body?.cancel().catch(() => {});
        throw httpError("Snapshot metadata unavailable", recheck.status);
      }

      await exact.body?.cancel().catch(() => {});
      throw httpError("Snapshot metadata unavailable", exact.status);
    }

    const wsSource = sourceOf(wsListed);

    if (wsSource !== undefined) return { snapshot: wsListed, provenSourceId: wsSource };
    throw new Error(
      "Snapshot missing from live source list and lacks source provenance in workspace list; no deletion attempted",
    );
  }

  if (!(await isBuddyMissing(source)))
    throw httpError("Snapshot metadata unavailable", source.status);

  const workspace = await buddyFetch(provider, "/sandboxes/snapshots", init);

  if (!workspace.ok) {
    await workspace.body?.cancel();
    throw httpError("Snapshot metadata unavailable", workspace.status);
  }

  const wsListed = (buddySnapshotList.parse(await workspace.json()).snapshots ?? []).find(
    (s) => s.id === id,
  );

  // When the source is gone, a single workspace-list miss never proves a confirmed snapshot is absent.
  if (!wsListed) throw new Error(buddyAbsenceUnproven);

  return { snapshot: wsListed, provenSourceId: sourceOf(wsListed) };
}

/** Read snapshot metadata without connecting to, activating, or requiring a live source sandbox. */
export async function inspectSnapshot(
  name: string,
  provider: Provider,
  sourceId: string,
  id: string,
  signal?: AbortSignal,
  expectedName?: string,
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

      case "agent37": {
        const read = await readAgent37Snapshot(provider, id, signal);

        if (read.kind === "absent") return { exists: false };

        // Only the adapter's snapshot marker proves an instance is a snapshot, and of which source.
        if (read.sourceId === undefined)
          throw new Error("Snapshot source metadata unavailable; no deletion attempted");

        return { exists: true, sourceId: read.sourceId };
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

      case "buddy": {
        // The exact journaled ID, its journaled name, and its source in the URL while the source exists.
        if (expectedName === undefined)
          throw new Error("Snapshot has no journaled name; no deletion attempted");
        const hit = await buddySnapshotById(provider, sourceId, id, signal);

        if (!hit) return { exists: false };

        if (hit.snapshot.name !== expectedName)
          throw new Error("Snapshot name differs from the journaled name; no deletion attempted");

        return hit.provenSourceId === undefined
          ? { exists: true }
          : { exists: true, sourceId: hit.provenSourceId };
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
      name !== "agent37" &&
      name !== "maritime" &&
      name !== "styne" &&
      name !== "buddy" &&
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

/** A save journaled before its request whose snapshot ID is not known yet (Buddy): its name and when. */
export interface PendingSave {
  name: string;
  journaledAt: string;
}

/**
 * Before a journaled snapshot entry is deleted or forgotten: a Maritime or Styne entry that still holds its
 * save's idempotency key is a save that never confirmed, so it is settled first ({@link settleMaritimeSave},
 * {@link settleStyneSave}); a Buddy entry holds its pending save's name ({@link settleBuddySave}), and
 * settling it finds the snapshot's ID. `absent` means nothing was saved and the entry may go; `exists` (or
 * any other entry) proceeds to the proven delete of the snapshot it names. An unsettled save throws, and the
 * entry stays for recovery.
 */
export async function settleJournaledSnapshot(
  name: string,
  provider: Provider,
  entry: {
    id: string;
    parent: string | null;
    idempotencyKey?: string;
    snapshotName?: string;
    pendingSave?: PendingSave;
  },
  timeoutMs: number,
): Promise<JournaledSnapshot> {
  if (name === "buddy") {
    if (entry.pendingSave === undefined) return { kind: "exists", id: entry.id };

    if (entry.parent === null) throw new Error("Snapshot source missing; no deletion attempted");

    return settleBuddySave({
      provider,
      sandboxId: entry.parent,
      name: entry.pendingSave.name,
      journaledAt: entry.pendingSave.journaledAt,
      timeoutMs,
    });
  }

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
  cleaner?: SnapshotDelete,
  expectedName?: string,
  parentSignal?: AbortSignal,
  options?: { deleteVerified?: boolean; onDeleteVerified?: () => Promise<void> },
) {
  const valid = snapshotProvenanceSchema.safeParse(proof);

  if (!valid.success || valid.data.sourceId !== parent || valid.data.runLabel !== run)
    throw new Error("Recorded snapshot provenance missing or mismatched; no deletion attempted");
  const end = performance.now() + Math.min(timeoutMs, 30000);
  let backoffMs = 100;
  let verifiedRecorded = options?.deleteVerified === true;

  const linkAbort = (budget: number) => {
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();

    if (parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const abortTimer = setTimeout(() => controller.abort(), budget);

    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(abortTimer);
        parentSignal?.removeEventListener("abort", onParentAbort);
        controller.abort();
      },
    };
  };

  for (;;) {
    const remaining = end - performance.now();

    if (remaining <= 0 || parentSignal?.aborted)
      throw new Error("Snapshot cleanup retry budget exhausted");

    const inspectAbort = linkAbort(remaining);
    let live: Awaited<ReturnType<typeof inspectSnapshot>>;

    try {
      try {
        live = await deadline(remaining, (signal) =>
          snapshotMetadata.inspect(
            name,
            provider,
            valid.data.sourceId,
            id,
            AbortSignal.any([signal, inspectAbort.signal]),
            expectedName,
          ),
        );
      } catch (error) {
        // When a prior attempt already verified live ownership and persisted deleteVerified before
        // issuing DELETE, a lost DELETE response leaves the workspace list empty after the source is
        // gone. Allow retrying DELETE (which still inspects the workspace list for conflicts and
        // settles cleanly on 404 Resource not found).
        if (
          name === "buddy" &&
          verifiedRecorded &&
          error instanceof Error &&
          error.message === buddyAbsenceUnproven
        )
          live = { exists: true };
        else throw error;
      }
    } finally {
      inspectAbort.cleanup();
    }

    if (parentSignal?.aborted) throw new Error("Snapshot cleanup retry budget exhausted");

    if (!live.exists) return;

    if (live.sourceId !== undefined && live.sourceId !== valid.data.sourceId)
      throw new Error("Snapshot source differs from recorded provenance; no deletion attempted");

    const remove =
      cleaner ?? (await snapshotCleaner(name, provider, valid.data.sourceId, expectedName));

    // Persist deleteVerified ONLY when the cleaner is actually about to issue DELETE (after all
    // final workspace name/source checks pass), never before a check that can reject the delete.
    const beforeDelete =
      !verifiedRecorded && options?.onDeleteVerified
        ? async () => {
            await options.onDeleteVerified?.();
            verifiedRecorded = true;
          }
        : undefined;

    try {
      const budget = end - performance.now();

      if (budget <= 0 || parentSignal?.aborted)
        throw new Error("Snapshot cleanup retry budget exhausted");
      const removeAbort = linkAbort(budget);

      try {
        await deadline(budget, (signal) =>
          remove(id, AbortSignal.any([signal, removeAbort.signal]), expectedName, beforeDelete),
        );
      } finally {
        removeAbort.cleanup();
      }

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

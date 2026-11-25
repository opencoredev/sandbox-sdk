/**
 * Microsandbox Cloud's control plane as the bench's cleanup and recovery read it, with plain `fetch` and
 * the bench's key: what an allocation attempt journaled before its create became, whether a journaled
 * Service is still the run's, whether a capture journaled before its request made a snapshot, and the
 * snapshot reads, deletes and listings snapshot recovery needs. Wire shapes follow
 * https://api.microsandbox.dev/docs/openapi.json (2026-11-24) and the official SDK's `CloudService`.
 */
import { z } from "zod";
import { microsandboxBase } from "./existence.js";

/** The label the bench adds to a Microsandbox create so its attempt hook names the call. */
export const attemptLabel = "sandbox-bench-attempt";

/** The label that names a Microsandbox sandbox's compute tier in bench sweeps. */
export const tierLabel = "sandbox-bench-tier";

/** The adapter's allocation marker label (`spec.labels`). */
const allocLabel = "sandbox-sdk-alloc";

/** The adapter's snapshot source label. */
const sourceLabel = "sandbox-sdk-source";

/**
 * How long after it was journaled an unresolved create is reported as stale. Never a proof of absence:
 * OpenAPI promises no time by which an accepted create shows up by name, so a 404 keeps the attempt
 * (and a restore's snapshot and source) for review however old it is.
 */
export const attemptSettlementMs = 15 * 60_000;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` is a managed snapshot ID (a UUID), not a snapshot name. */
export const isMicrosandboxSnapshotId = (id: string) => uuidPattern.test(id);

export class MicrosandboxHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(`${message} (HTTP ${status})`);
  }
}

/** One control-plane request with the bench's key, bounded. */
export function microsandboxFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);

  headers.set("Authorization", `Bearer ${process.env.MSB_API_KEY ?? ""}`);

  return fetch(`${microsandboxBase()}${path}`, {
    ...init,
    headers,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
}

const sandboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  compute: z.object({ type: z.string() }).nullish(),
  spec: z.object({ labels: z.record(z.string(), z.string()).default({}) }).nullish(),
});

const serviceSchema = z.object({
  slug: z.string(),
  status: z.string(),
  target: z.object({ sandbox: z.string(), port: z.number() }).nullish(),
  created_at: z.string().optional(),
});

export const microsandboxSnapshotSchema = z.object({
  name: z.string(),
  location: z.object({ type: z.string(), id: z.string().optional() }),
  sandbox_id: z.string().nullish(),
  labels: z.record(z.string(), z.string()).default({}),
});

export type MicrosandboxSnapshot = z.infer<typeof microsandboxSnapshotSchema>;

const operationSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "in_progress", "succeeded", "failed"]),
  snapshot_name: z.string().optional(),
  sandbox_id: z.string().nullish(),
  result: microsandboxSnapshotSchema.nullish(),
});

const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), next_cursor: z.string().nullish() });

/** A journaled create, before its answer is trusted: what the adapter's attempt hook reported. */
export interface AllocationAttempt {
  /** The sandbox name the create sent. */
  id: string;
  allocId: string | undefined;
  attemptedAt: string | undefined;
}

export type AttemptOutcome = { kind: "sandbox"; id: string } | { kind: "pending"; reason: string };

/**
 * What a journaled create became, read by its name. Only a sandbox carrying the attempt's allocation
 * marker, on the expected tier, is the run's. A name lookup never proves the create made nothing: a 404
 * stays pending however old the attempt is, as do an unresolved spec and another marker. An attempt is
 * retired only by a confirmed sandbox here or by the adapter's definite refusal while it ran.
 */
export async function settleAllocationAttempt(
  entry: AllocationAttempt,
  tier: "standard" | "shared",
  now = Date.now(),
): Promise<AttemptOutcome> {
  if (entry.allocId === undefined) return { kind: "pending", reason: "Attempt has no marker" };
  const response = await microsandboxFetch(`/sandboxes/by-name/${encodeURIComponent(entry.id)}`);

  if (response.status === 404) {
    await response.body?.cancel();
    const at = entry.attemptedAt === undefined ? Number.NaN : Date.parse(entry.attemptedAt);
    const stale = Number.isFinite(at) && now - at >= attemptSettlementMs;

    return {
      kind: "pending",
      reason: stale
        ? "Create still not found by name after 15 minutes; a 404 does not prove it was never made, so it is kept for review"
        : "Create not found by name yet; it may still appear",
    };
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new MicrosandboxHttpError("Microsandbox create lookup failed", response.status);
  }

  const sandbox = sandboxSchema.parse(await response.json());

  if (sandbox.name !== entry.id) throw new Error("Microsandbox lookup answered another sandbox");

  if (!sandbox.spec) return { kind: "pending", reason: "Sandbox spec not resolved yet" };

  if (sandbox.spec.labels[allocLabel] !== entry.allocId)
    return { kind: "pending", reason: "A sandbox under this name carries another marker" };

  if (sandbox.compute?.type !== tier)
    return {
      kind: "pending",
      reason: `Sandbox is on ${sandbox.compute?.type ?? "an unknown"} compute`,
    };

  return { kind: "sandbox", id: sandbox.id };
}

/**
 * What the journal knows of a Service's create. `pending`: journaled before its POST, outcome unknown.
 * `created`: the adapter confirmed it made this Service for the sandbox. A 409 or other refusal removes
 * the entry instead, so a slug that was someone else's is never left looking like the run's.
 */
export type ServiceState = "pending" | "created";

/** A journaled Service: its slug, the sandbox it was made for, and that sandbox's name. */
export interface ServiceEntry {
  id: string;
  parent: string | null;
  sandboxName: string | undefined;
  state: ServiceState;
  /** The server `created_at` from the confirmed create, used to reject a reused slug after deletion. */
  createdAt?: string | undefined;
  /**
   * The journal also holds a later slug the adapter tried for the same sandbox and port
   * (`<slug>-<4 hex>`). The adapter tries one only after this slug was taken, so a detached Service
   * here is someone else's.
   */
  superseded: boolean;
  /**
   * Called before DELETE when a live attached read proves this Service belongs to `sandboxName` and
   * the journal entry is still `pending` or lacks `createdAt`, so the durable journal upgrades first.
   */
  onVerified?: (createdAt: string | undefined) => void | Promise<void>;
}

/** Whether `other` is a retry slug the adapter makes after `slug` was taken: `<slug>-<4 hex>`. */
export const isRetrySlug = (other: string, slug: string) =>
  other.startsWith(`${slug}-`) && /^-[0-9a-f]{4}$/.test(other.slice(slug.length));

export interface ServiceOrderEntry {
  readonly id: string;
  readonly parent: string | null;
  readonly serviceSuperseded?: boolean;
}

/**
 * Whether `services[index]` is known to have hit a 409 conflict:
 * - `serviceSuperseded === true`: durably recorded when a retry slug was journaled or retired.
 * - `serviceSuperseded === false`: explicitly re-attempted after an older retry slug, so an older
 *   retry slug cannot mask this newer attempt.
 * - `serviceSuperseded === undefined` (older journals): superseded only by a retry slug
 *   (`<id>-<4 hex>`) recorded AFTER `services[index]` in the journal.
 */
export function isServiceSuperseded(
  services: readonly ServiceOrderEntry[],
  index: number,
): boolean {
  const entry = services[index];

  if (entry === undefined) return false;

  if (entry.serviceSuperseded === true) return true;

  if (entry.serviceSuperseded === false) return false;

  return services.some(
    (other, otherIndex) =>
      otherIndex > index && other.parent === entry.parent && isRetrySlug(other.id, entry.id),
  );
}

export type ServiceOutcome =
  | { kind: "gone" }
  | { kind: "foreign" }
  | { kind: "pending"; reason: string };

export type ServiceProbeOutcome =
  | { kind: "attached"; createdAt: string | undefined }
  | { kind: "not-found" }
  | { kind: "other" };

/**
 * Read-only exact check for an unresolved Service before deleting its parent sandbox. Returns
 * `attached` with the server `created_at` when the live Service still targets `sandboxName`,
 * `not-found` on 404 (so a pending create keeps its parent sandbox until settled), `other` when
 * detached or targeting another sandbox, and throws on HTTP/network errors so the parent sandbox
 * is kept until attachment can be checked.
 */
export async function probePendingService(
  slug: string,
  sandboxName: string,
): Promise<ServiceProbeOutcome> {
  const read = await microsandboxFetch(`/services/${encodeURIComponent(slug)}`);

  if (read.status === 404) {
    await read.body?.cancel();

    return { kind: "not-found" };
  }

  if (!read.ok) {
    await read.body?.cancel();
    throw new MicrosandboxHttpError("Microsandbox Service read failed", read.status);
  }

  const service = serviceSchema.parse(await read.json());

  if (service.slug !== slug) throw new Error("Microsandbox Service read answered another slug");

  if (
    service.target !== null &&
    service.target !== undefined &&
    service.target.sandbox === sandboxName
  )
    return { kind: "attached", createdAt: service.created_at };

  return { kind: "other" };
}

/**
 * Deletes a journaled Service when ownership is proven: it targets the journaled sandbox name, or it
 * is detached after a confirmed create (`state === "created"`) and nothing says the slug was taken.
 * A detached Service whose create is still `pending` cannot be distinguished from a pre-existing
 * detached Service whose 409 settlement failed to persist, so it stays `pending` for review. One
 * targeting anything else, or a detached or missing one at a superseded slug, is never touched.
 * Runs whether or not the sandbox still exists. `gone` once a read confirms 404 for a Service the
 * adapter confirmed it made; `foreign` on 404 when the slug was superseded after a 409 conflict; a
 * 404 for an unsuperseded pending create stays `pending`, because the create may still land.
 */
export async function cleanService(entry: ServiceEntry): Promise<ServiceOutcome> {
  const path = `/services/${encodeURIComponent(entry.id)}`;
  const read = await microsandboxFetch(path);

  if (read.status === 404) {
    await read.body?.cancel();

    if (entry.superseded) return { kind: "foreign" };

    return entry.state === "created"
      ? { kind: "gone" }
      : {
          kind: "pending",
          reason:
            "Service create unsettled and not found yet; it may still appear, so its journal entry is kept",
        };
  }

  if (!read.ok) {
    await read.body?.cancel();
    throw new MicrosandboxHttpError("Microsandbox Service read failed", read.status);
  }

  const service = serviceSchema.parse(await read.json());

  if (service.slug !== entry.id) throw new Error("Microsandbox Service read answered another slug");

  if (entry.sandboxName === undefined) return { kind: "foreign" };

  if (service.target !== null && service.target !== undefined) {
    if (service.target.sandbox !== entry.sandboxName) return { kind: "foreign" };

    if (
      entry.state !== "created" ||
      (entry.createdAt === undefined && service.created_at !== undefined)
    )
      await entry.onVerified?.(service.created_at);
  } else if (service.status === "detached" && !entry.superseded) {
    if (entry.state !== "created")
      return {
        kind: "pending",
        reason:
          "Detached Service has an unsettled create; ownership cannot be proven, so it is kept for review",
      };

    if (entry.createdAt === undefined || service.created_at === undefined)
      return {
        kind: "pending",
        reason:
          "Detached Service lacks creation timestamp proof; kept for review so a reused slug is never deleted",
      };

    if (service.created_at !== entry.createdAt) return { kind: "foreign" };
  } else {
    return { kind: "foreign" };
  }

  const removed = await microsandboxFetch(path, { method: "DELETE" });
  await removed.body?.cancel();

  if (!removed.ok && removed.status !== 404)
    throw new MicrosandboxHttpError("Microsandbox Service delete failed", removed.status);
  const check = await microsandboxFetch(path);
  await check.body?.cancel();

  if (check.status !== 404)
    throw new MicrosandboxHttpError(
      "Microsandbox Service still readable after delete",
      check.status,
    );

  return { kind: "gone" };
}

/** A snapshot by managed ID (a UUID) or by name; undefined on a 404. */
export async function readMicrosandboxSnapshot(
  id: string,
): Promise<MicrosandboxSnapshot | undefined> {
  const path = uuidPattern.test(id)
    ? `/snapshots/${encodeURIComponent(id)}`
    : `/snapshots/by-name/${encodeURIComponent(id)}`;

  const response = await microsandboxFetch(path);

  if (response.status === 404) {
    await response.body?.cancel();

    return undefined;
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new MicrosandboxHttpError("Microsandbox snapshot read failed", response.status);
  }

  const snapshot = microsandboxSnapshotSchema.parse(await response.json());
  const matches = uuidPattern.test(id) ? snapshot.location.id === id : snapshot.name === id;

  if (!matches) throw new Error("Snapshot metadata ID mismatch");

  return snapshot;
}

/** Whether a snapshot was captured from `sourceId`: its own `sandbox_id` or the adapter's source label. */
export const capturedFrom = (snapshot: MicrosandboxSnapshot, sourceId: string) =>
  snapshot.sandbox_id === sourceId || snapshot.labels[sourceLabel] === sourceId;

/** The source a snapshot records: `sandbox_id`, else the adapter's source label. */
export const recordedSource = (snapshot: MicrosandboxSnapshot) =>
  snapshot.sandbox_id ?? snapshot.labels[sourceLabel];

/** Deletes a snapshot by managed ID or by name; a 404 is already gone. */
export async function deleteMicrosandboxSnapshot(id: string) {
  const path = uuidPattern.test(id)
    ? `/snapshots/${encodeURIComponent(id)}`
    : `/snapshots/by-name/${encodeURIComponent(id)}`;

  const response = await microsandboxFetch(path, { method: "DELETE" });
  await response.body?.cancel();

  if (!response.ok && response.status !== 404)
    throw new MicrosandboxHttpError("Microsandbox snapshot delete failed", response.status);
}

/** The capture operation that made (or is making) `snapshotName`, from recent operations. */
async function findOperation(snapshotName: string) {
  let cursor: string | undefined;

  for (let index = 0; index < 10; index++) {
    const query = new URLSearchParams({ limit: "100" });

    if (cursor !== undefined) query.set("cursor", cursor);
    const response = await microsandboxFetch(`/snapshot-operations?${query}`);

    if (!response.ok) {
      await response.body?.cancel();
      throw new MicrosandboxHttpError("Microsandbox operation listing failed", response.status);
    }

    const answer = page(operationSchema).parse(await response.json());
    const found = answer.data.find((op) => op.snapshot_name === snapshotName);

    if (found) return found;
    cursor = answer.next_cursor ?? undefined;

    if (cursor === undefined) return undefined;
  }

  return undefined;
}

/** A settled capture: the managed snapshot it made, by the UUID cleanup must use, or nothing. */
export type CaptureOutcome = { kind: "exists"; managedId: string } | { kind: "absent" };

/** The managed ID of a snapshot read back, or undefined when it is not in managed storage. */
const managedIdOf = (snapshot: MicrosandboxSnapshot) =>
  snapshot.location.type === "managed" ? snapshot.location.id : undefined;

/**
 * Whether a capture journaled by name before its request made a snapshot, and its managed ID. `exists`
 * when the snapshot reads by name, or its operation succeeded with a snapshot that still reads by that
 * ID; `absent` only when the operation failed, or succeeded with a snapshot whose ID now reads 404.
 * Anything else (a 404 with no operation, a queued or running one, a snapshot with no managed ID)
 * throws, so the entry stays for recovery: an unresolved 404 never clears it.
 */
export async function settleMicrosandboxCapture(
  snapshotName: string,
  timeoutMs: number,
): Promise<CaptureOutcome> {
  const end = Date.now() + Math.min(timeoutMs, 60_000);
  let reason = "Capture unresolved";

  for (let attempt = 0; ; attempt++) {
    const named = await readMicrosandboxSnapshot(snapshotName);

    if (named !== undefined) {
      const managedId = managedIdOf(named);

      if (managedId === undefined)
        throw new Error("Capture's snapshot has no managed ID; journal entry kept");

      return { kind: "exists", managedId };
    }

    const op = await findOperation(snapshotName);

    if (op?.status === "failed") return { kind: "absent" };

    if (op?.status === "succeeded") {
      const id = op.result === null || op.result === undefined ? undefined : managedIdOf(op.result);

      if (id !== undefined)
        return (await readMicrosandboxSnapshot(id))
          ? { kind: "exists", managedId: id }
          : { kind: "absent" };
      reason = "Capture succeeded but its result is unreadable";
    } else
      reason =
        op === undefined
          ? "Capture not found by name or operation; it may still appear"
          : `Capture operation is ${op.status}`;

    if (Date.now() + 2000 * 2 ** Math.min(attempt, 3) > end)
      throw new Error(`${reason}; journal entry kept`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** Math.min(attempt, 3)));
  }
}

/**
 * The journaled snapshots of one source: every snapshot whose source is `sourceId` and whose managed ID
 * or name the journal holds. Others of the same source are never touched.
 */
export async function microsandboxSnapshotsFromSource(
  sourceId: string,
  journaled: ReadonlySet<string>,
) {
  const found: { id: string; name: string }[] = [];
  let cursor: string | undefined;

  for (let index = 0; index < 100; index++) {
    const query = new URLSearchParams({ limit: "100" });

    if (cursor !== undefined) query.set("cursor", cursor);
    const response = await microsandboxFetch(`/snapshots?${query}`);

    if (!response.ok) {
      await response.body?.cancel();
      throw new MicrosandboxHttpError("Microsandbox snapshot listing failed", response.status);
    }

    const answer = page(microsandboxSnapshotSchema).parse(await response.json());

    for (const snapshot of answer.data) {
      const id = snapshot.location.id;

      if (
        snapshot.location.type === "managed" &&
        id !== undefined &&
        capturedFrom(snapshot, sourceId) &&
        (journaled.has(id) || journaled.has(snapshot.name))
      )
        found.push({ id, name: snapshot.name });
    }

    cursor = answer.next_cursor ?? undefined;

    if (cursor === undefined) return found;
  }

  throw new Error("Snapshot recovery exceeded pagination bound");
}

/** Error codes the adapter uses for a refusal made before anything was allocated or captured. */
const refusalCodes: ReadonlySet<string> = new Set([
  "invalid_argument",
  "auth",
  "quota",
  "not_found",
  "unsupported",
]);

/** Whether an adapter failure proves its create or capture never allocated anything. */
export function isDefiniteRefusal(code: string | undefined) {
  return code !== undefined && refusalCodes.has(code);
}

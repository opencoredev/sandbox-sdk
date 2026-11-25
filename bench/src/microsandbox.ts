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
 * How long a journaled create that reads 404 by name stays unresolved: a create can be slow to appear,
 * and an attempt is cleared on absence only after this long.
 */
export const attemptSettlementMs = 15 * 60_000;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export type AttemptOutcome =
  | { kind: "sandbox"; id: string }
  | { kind: "absent" }
  | { kind: "pending"; reason: string };

/**
 * What a journaled create became, read by its name. Only a sandbox carrying the attempt's allocation
 * marker, on the expected tier, is the run's. A 404 is absence only once the attempt is older than
 * {@link attemptSettlementMs}; until then, and for an unresolved spec or another marker, it stays pending.
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

    return Number.isFinite(at) && now - at >= attemptSettlementMs
      ? { kind: "absent" }
      : { kind: "pending", reason: "Create not found by name yet; it may still appear" };
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

/** A journaled Service: its slug, the sandbox it was made for, and that sandbox's name. */
export interface ServiceEntry {
  id: string;
  parent: string | null;
  sandboxName: string | undefined;
}

/**
 * Deletes a journaled Service when it is still the run's: it targets the journaled sandbox name, or it
 * is detached (its sandbox was deleted). One targeting anything else is never touched. Runs whether or
 * not the sandbox still exists. `gone` once a read confirms 404.
 */
export async function cleanService(entry: ServiceEntry): Promise<"gone" | "foreign"> {
  const path = `/services/${encodeURIComponent(entry.id)}`;
  const read = await microsandboxFetch(path);

  if (read.status === 404) {
    await read.body?.cancel();

    return "gone";
  }

  if (!read.ok) {
    await read.body?.cancel();
    throw new MicrosandboxHttpError("Microsandbox Service read failed", read.status);
  }

  const service = serviceSchema.parse(await read.json());

  if (service.slug !== entry.id) throw new Error("Microsandbox Service read answered another slug");

  const ours =
    entry.sandboxName !== undefined &&
    (service.target !== null && service.target !== undefined
      ? service.target.sandbox === entry.sandboxName
      : service.status === "detached");

  if (!ours) return "foreign";
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

  return "gone";
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

/**
 * Whether a capture journaled by name before its request made a snapshot. `exists` when the snapshot
 * reads by name, or its operation succeeded with a snapshot that still reads; `absent` only when the
 * operation failed, or succeeded with a snapshot since deleted. Anything else (a 404 with no operation,
 * a queued or running one) throws, so the entry stays for recovery: an unresolved 404 never clears it.
 */
export async function settleMicrosandboxCapture(
  snapshotName: string,
  timeoutMs: number,
): Promise<"exists" | "absent"> {
  const end = Date.now() + Math.min(timeoutMs, 60_000);
  let reason = "Capture unresolved";

  for (let attempt = 0; ; attempt++) {
    if ((await readMicrosandboxSnapshot(snapshotName)) !== undefined) return "exists";
    const op = await findOperation(snapshotName);

    if (op?.status === "failed") return "absent";

    if (op?.status === "succeeded") {
      const id = op.result?.location.id;

      if (id !== undefined) return (await readMicrosandboxSnapshot(id)) ? "exists" : "absent";
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

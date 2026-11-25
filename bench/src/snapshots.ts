import { z } from "zod";
import type { DaytonaNative } from "@opencoredev/sandbox-sdk/daytona";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import {
  localDocker,
  lookupError,
  maritimeBase,
  nativeModules,
  type NativeModules,
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
import { deadline } from "./timing.js";
import { snapshotProvenanceSchema, type SnapshotProvenance } from "./ownership.js";

async function daytonaSnapshots() {
  const { Daytona } = await nativeModules.load("@daytonaio/sdk");

  return new Daytona().snapshot;
}

async function boxdSnapshots() {
  const { Boxd } = await nativeModules.load("@boxd-sh/sdk");

  return new Boxd({ apiKey: process.env.BOXD_API_KEY }).snapshots;
}

async function freestyleSnapshots() {
  const { Freestyle } = await nativeModules.load("freestyle");

  return new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY }).vms.snapshots;
}

async function tenkiClient() {
  const { TenkiSandbox } = await nativeModules.load("@tenkicloud/sandbox");

  return new TenkiSandbox({ authToken: process.env.TENKI_API_KEY ?? process.env.TENKI_AUTH_TOKEN });
}

/** Run `action` with a fresh Modal client, closed afterwards. Cleanup can outlive the adapter's client. */
async function withModal<T>(
  action: (
    client: InstanceType<NativeModules["modal"]["ModalClient"]>,
    modal: NativeModules["modal"],
  ) => Promise<T>,
): Promise<T> {
  const modal = await nativeModules.load("modal");
  const client = new modal.ModalClient();

  try {
    return await action(client, modal);
  } finally {
    client.close();
  }
}

/** Maritime's control plane with the bench's key. Snapshot calls never need the source to be running. */
function maritimeFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);

  headers.set("Authorization", `Bearer ${process.env.MARITIME_API_KEY ?? ""}`);

  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  return fetch(`${maritimeBase()}${path}`, { ...init, headers });
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
  sandboxId: string,
  name: string,
  idempotencyKey: string,
) {
  const response = await maritimeFetch(`/sandboxes/${encodeURIComponent(sandboxId)}/save`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(600_000),
  });

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
async function readMaritimeSnapshot(name: string, sandboxId: string, signal: AbortSignal) {
  const response = await maritimeFetch(`/snapshots/${encodeURIComponent(name)}`, { signal });

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

/**
 * Decides a Maritime save whose answer was lost, timed out or unreadable: whether its snapshot exists.
 * It sends the journaled save again with the same idempotency key, which returns the first save's
 * outcome (or makes the save once), then reads the snapshot whatever the replay answered, so a snapshot
 * that is already visible is found even when the replay failed. A `404 snapshot_not_found` read is
 * final only when the replay refused the save ({@link isSaveRefusal}); otherwise it is read again until
 * the snapshot shows or the deadline passes, which throws and keeps the journal entry.
 */
export async function settleMaritimeSave(input: {
  sandboxId: string;
  name: string;
  idempotencyKey: string;
  timeoutMs: number;
}): Promise<"exists" | "absent"> {
  const end = Date.now() + input.timeoutMs;
  let backoffMs = 500;

  for (;;) {
    const left = end - Date.now();

    if (left <= 0) throw new Error("Maritime snapshot save did not settle; journal entry kept");

    const signal = AbortSignal.timeout(Math.min(60_000, left));
    let refused = false;

    try {
      const response = await maritimeFetch(
        `/sandboxes/${encodeURIComponent(input.sandboxId)}/save`,
        {
          method: "POST",
          headers: { "Idempotency-Key": input.idempotencyKey },
          body: JSON.stringify({ name: input.name }),
          signal,
        },
      );

      if (response.status === 404 || response.status === 410) {
        refused = isSaveRefusal(response.status, await readMaritimeErrorCode(response));
      } else {
        refused = isSaveRefusal(response.status, undefined);
        await response.body?.cancel();
      }
    } catch {
      refused = false;
    }

    const read = await readMaritimeSnapshot(
      input.name,
      input.sandboxId,
      AbortSignal.timeout(Math.max(1, Math.min(30_000, end - Date.now()))),
    ).catch((cause: unknown) => {
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
 * Maritime's snapshots of one sandbox that this run journaled by name before saving them. The account's
 * list also has the stock templates and snapshots others saved; the run names its own before the request,
 * so nothing else is ever its to delete.
 */
async function snapshotsFromMaritimeSandbox(
  sourceSandboxId: string,
  journaled: ReadonlySet<string>,
) {
  const found: { id: string; name: string }[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "100" });

    if (cursor !== null) query.set("cursor", cursor);

    const response = await maritimeFetch(`/snapshots?${query}`);

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

function instaboxBase() {
  return process.env.INSTABOX_API_URL ?? "https://api.instabox.sh";
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
): Promise<(id: string) => Promise<void>> {
  if (name === "instabox") {
    // A fresh request: cleanup can run after the source machine is gone.
    return async (id) => {
      const response = await fetch(`${instaboxBase()}/v1/snapshots/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: {
          "X-API-Key": process.env.INSTABOX_API_KEY ?? "",
          "Idempotency-Key": crypto.randomUUID(),
          "X-Confirm-Delete": id,
        },
      });

      if (!response.ok && response.status !== 404)
        throw Object.assign(new Error("Instabox snapshot delete failed"), {
          status: response.status,
        });
    };
  }

  if (name === "superserve") {
    const { Snapshot } = await nativeModules.load("@superserve/sdk");

    return async (id) => {
      await Snapshot.deleteById(id);
    };
  }

  if (microsandboxTier(name) !== undefined)
    // By managed ID, or by name for a capture journaled before it was answered; also after the source
    // sandbox is gone.
    return deleteMicrosandboxSnapshot;

  if (name === "maritime") {
    // Deleted by name, also after the source sandbox has ended. Only `404 snapshot_not_found`
    // confirms absence; a route-level `404 resource_not_found` must fail so recovery retains it.
    return async (id) => {
      const response = await maritimeFetch(`/snapshots/${encodeURIComponent(id)}`, {
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

  if (name === "local") {
    const docker = localDocker(provider, sandboxId);

    return async (id) => {
      await docker.call("DELETE", `/images/${encodeURIComponent(id)}`);
    };
  }

  if (name === "boxd") {
    // A fresh client: cleanup can run after the source machine is gone, when the adapter's native handle is not.
    const snapshots = await boxdSnapshots();

    return async (id) => {
      await snapshots.delete(id);
    };
  }

  if (name === "upstash") {
    const { Box } = await nativeModules.load("@upstash/box");

    return async (id) => {
      await Box.deleteSnapshots({ snapshotIds: [id] });
    };
  }

  if (name === "e2b") {
    const { Sandbox } = await nativeModules.load("e2b");

    return async (id) => {
      await Sandbox.deleteSnapshot(id);
    };
  }

  if (name === "daytona") {
    const snapshots = await daytonaSnapshots();

    return async (id) => {
      await snapshots.delete(id);
    };
  }

  if (name === "freestyle") {
    const snapshots = await freestyleSnapshots();

    return async (id) => {
      await snapshots.delete(id);
    };
  }

  if (name === "tenki") {
    const tenki = await tenkiClient();

    return async (id) => {
      await tenki.deleteSnapshot(id);
    };
  }

  if (name === "modal")
    // A snapshot is a Modal Image. Its delete also succeeds for a missing image; inspect runs first.
    return (id) => withModal((client) => client.images.delete(id));

  if (name === "vercel") {
    const { Snapshot } = await nativeModules.load("@vercel/sandbox");

    return async (id) => {
      await (await Snapshot.get({ snapshotId: id })).delete();
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

/** Narrow recovery query for snapshots of a sandbox whose run ownership was already established. */
export async function snapshotsFromDaytonaSandbox(sourceSandboxId: string) {
  const snapshots = await daytonaSnapshots();

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
 * IDs the journal holds for that source; providers whose names the run picks before saving (Maritime)
 * keep only those.
 */
export async function snapshotsFromSource(
  provider: string,
  sourceSandboxId: string,
  journaled: ReadonlySet<string> = new Set(),
) {
  if (provider === "maritime") return snapshotsFromMaritimeSandbox(sourceSandboxId, journaled);

  if (microsandboxTier(provider) !== undefined)
    return microsandboxSnapshotsFromSource(sourceSandboxId, journaled);

  if (provider !== "superserve") return snapshotsFromDaytonaSandbox(sourceSandboxId);

  const { Snapshot } = await nativeModules.load("@superserve/sdk");

  return z
    .array(z.object({ id: z.string(), name: z.string().optional() }))
    .parse(await Snapshot.list(sourceSandboxId));
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
): Promise<{ exists: boolean; sourceId?: string }> {
  // Microsandbox: by managed ID or name. The source is the snapshot's own `sandbox_id`, or the adapter's
  // source label; a snapshot that records neither is never attributed to anyone.
  if (microsandboxTier(name) !== undefined) {
    const snapshot = await readMicrosandboxSnapshot(id);

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
        const page = Sandbox.listSnapshots({ name: id, limit: 100 });

        for (let index = 0; index < 100; index++) {
          const items = z.array(z.object({ snapshotId: z.string() })).parse(await page.nextItems());

          if (items.some((item) => item.snapshotId === id)) return { exists: true };

          if (page.hasNext === false || !items.length)
            throw new Error("Snapshot metadata not visible; absence unproven");
        }

        throw new Error("Snapshot metadata pagination exhausted");
      }

      case "daytona": {
        const snapshots = await daytonaSnapshots();

        info = snapshotInfo.parse(await snapshots.get(id));
        break;
      }

      case "boxd": {
        const snapshots = await boxdSnapshots();

        info = snapshotInfo.parse(await snapshots.get(id));
        break;
      }

      case "tenki": {
        const tenki = await tenkiClient();

        info = snapshotInfo.parse(await tenki.getSnapshot(id));
        break;
      }

      case "freestyle": {
        const snapshots = await freestyleSnapshots();

        info = snapshotInfo.parse(await snapshots.get(id));
        break;
      }

      case "instabox": {
        const response = await fetch(`${instaboxBase()}/v1/snapshots/${encodeURIComponent(id)}`, {
          headers: { "X-API-Key": process.env.INSTABOX_API_KEY ?? "" },
        });

        if (!response.ok)
          throw Object.assign(new Error("Snapshot metadata unavailable"), {
            status: response.status,
          });
        info = snapshotInfo.parse(await response.json());
        break;
      }

      case "superserve": {
        const { Snapshot } = await nativeModules.load("@superserve/sdk");

        info = snapshotInfo.parse(await Snapshot.get(id));
        break;
      }

      case "maritime": {
        const response = await maritimeFetch(`/snapshots/${encodeURIComponent(id)}`);

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
        const response = await fetch(
          `${process.env.UPSTASH_BOX_BASE_URL ?? "https://us-east-1.box.upstash.com"}/v2/box/snapshots`,
          { headers: { Authorization: `Bearer ${process.env.UPSTASH_BOX_API_KEY ?? ""}` } },
        );

        if (!response.ok)
          throw Object.assign(new Error("Snapshot metadata unavailable"), {
            status: response.status,
          });
        const list = z.object({ snapshots: z.array(snapshotInfo) }).parse(await response.json());
        const listed = list.snapshots.find((snapshot) => snapshot.id === id);

        if (!listed) throw new Error("Snapshot metadata not visible; absence unproven");
        info = listed;
        break;
      }

      case "modal": {
        // Modal Images record no source sandbox, so provenance rests on the ownership journal.
        const found = await withModal(async (client, modal) => {
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
        const snapshot = await Snapshot.get({ snapshotId: id });

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
      ["daytona", "superserve", "tenki", "freestyle", "upstash", "instabox"].includes(name) &&
      !parent
    )
      throw new Error("Snapshot source metadata unavailable");

    if (!parent) return { exists: true };

    return { exists: true, sourceId: parent };
  } catch (error) {
    if (
      name !== "maritime" &&
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
 * Before a journaled snapshot entry is deleted or forgotten: a Maritime entry that still holds its save's
 * idempotency key is a save that never confirmed, so it is settled first ({@link settleMaritimeSave}).
 * `absent` means nothing was saved and the entry may go; `exists` (or any other entry) proceeds to the
 * proven delete of the snapshot it names. An unsettled save throws, and the entry stays for recovery.
 */
export async function settleJournaledSnapshot(
  name: string,
  entry: { id: string; parent: string | null; idempotencyKey?: string; snapshotName?: string },
  timeoutMs: number,
): Promise<JournaledSnapshot> {
  // Microsandbox: a capture journaled by name before its request, never confirmed. Settled through the
  // snapshot and its operation, keeping the managed ID it finds; an unresolved 404 throws and keeps the entry.
  if (microsandboxTier(name) !== undefined && entry.snapshotName === entry.id) {
    const capture = await settleMicrosandboxCapture(entry.id, timeoutMs);

    return capture.kind === "exists" ? { kind: "exists", id: capture.managedId } : capture;
  }

  if (name !== "maritime" || entry.idempotencyKey === undefined)
    return { kind: "exists", id: entry.id };

  if (entry.parent === null) throw new Error("Snapshot source missing; no deletion attempted");

  const saved = await settleMaritimeSave({
    sandboxId: entry.parent,
    name: entry.id,
    idempotencyKey: entry.idempotencyKey,
    timeoutMs,
  });

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
  cleaner?: (id: string) => Promise<void>,
) {
  const valid = snapshotProvenanceSchema.safeParse(proof);

  if (!valid.success || valid.data.sourceId !== parent || valid.data.runLabel !== run)
    throw new Error("Recorded snapshot provenance missing or mismatched; no deletion attempted");
  const end = performance.now() + Math.min(timeoutMs, 30000);
  let backoffMs = 100;

  for (;;) {
    const remaining = end - performance.now();

    if (remaining <= 0) throw new Error("Snapshot cleanup retry budget exhausted");

    const live = await deadline(remaining, () =>
      snapshotMetadata.inspect(name, provider, valid.data.sourceId, id),
    );

    if (!live.exists) return;

    if (live.sourceId !== undefined && live.sourceId !== valid.data.sourceId)
      throw new Error("Snapshot source differs from recorded provenance; no deletion attempted");
    const remove = cleaner ?? (await snapshotCleaner(name, provider, valid.data.sourceId));

    try {
      await deadline(Math.max(1, end - performance.now()), () => remove(id));

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

import { z } from "zod";
import type { Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { localDocker, lookupError, nativeModules } from "./existence.js";
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

export async function snapshotCleaner(
  name: string,
  provider: Provider,
  sandboxId: string,
): Promise<(id: string) => Promise<void>> {
  if (name === "superserve") {
    const { Snapshot } = await nativeModules.load("@superserve/sdk");

    return async (id) => {
      await Snapshot.deleteById(id);
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

  throw new Error("Snapshot cleanup not registered");
}

/** The Daytona adapter's native handle, as far as snapshot creation uses it. */
type DaytonaHandle = Pick<DaytonaSandbox, "createSnapshot">;

/** Whether a native handle can create a Daytona snapshot. `Provider` erases the handle's type. */
function isDaytonaHandle(handle: unknown): handle is DaytonaHandle {
  return (
    typeof handle === "object" &&
    handle !== null &&
    "createSnapshot" in handle &&
    typeof handle.createSnapshot === "function"
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

  await handle.createSnapshot(name, 600);

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

/** Query only a source sandbox already recorded in the run ownership journal. */
export async function snapshotsFromSource(provider: string, sourceSandboxId: string) {
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
});

type SnapshotInfo = z.infer<typeof snapshotInfo>;

/** Read snapshot metadata without connecting to, activating, or requiring a live source sandbox. */
export async function inspectSnapshot(
  name: string,
  provider: Provider,
  sourceId: string,
  id: string,
): Promise<{ exists: boolean; sourceId?: string }> {
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

      case "superserve": {
        const { Snapshot } = await nativeModules.load("@superserve/sdk");

        info = snapshotInfo.parse(await Snapshot.get(id));
        break;
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
      info.sourceSandboxId ?? info.sandboxId ?? info.sessionId ?? info.sourceVmId ?? info.box_id;

    // These APIs expose provenance: unreadable or cleared source fields cannot authorize deletion.
    if (["daytona", "superserve", "tenki", "freestyle", "upstash"].includes(name) && !parent)
      throw new Error("Snapshot source metadata unavailable");

    if (!parent) return { exists: true };

    return { exists: true, sourceId: parent };
  } catch (error) {
    if (lookupError(error, name, `${name}:snapshot-exact-get`).result === "not-found")
      return { exists: false };
    throw error;
  }
}

export const snapshotMetadata = { inspect: inspectSnapshot };

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

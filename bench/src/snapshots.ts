import { z } from "zod";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { nativeModules, lookupError } from "./existence.js";
import { deadline } from "./timing.js";
import { snapshotProvenanceSchema, type SnapshotProvenance } from "./ownership.js";

const fn = z.custom<(...args: unknown[]) => Promise<unknown>>((v) => typeof v === "function");
const constructor = z.custom<new (options?: unknown) => unknown>((v) => typeof v === "function");

function member(target: unknown, name: string): unknown {
  if ((typeof target !== "object" || target === null) && typeof target !== "function")
    throw new Error(`Invalid snapshot client: ${name}`);

  return Reflect.get(target, name);
}

async function call(target: unknown, name: string, ...args: unknown[]) {
  return fn.parse(member(target, name)).apply(target, args);
}

async function client(moduleName: string, exportName: string, options: unknown) {
  const module: unknown = await nativeModules.load(moduleName);
  const C = constructor.parse(member(module, exportName));

  return new C(options);
}

export async function snapshotCleaner(
  name: string,
  provider: Provider,
  sandboxId: string,
): Promise<(id: string) => Promise<void>> {
  if (name === "superserve") {
    const mod: unknown = await nativeModules.load("@superserve/sdk");
    const c = member(mod, "Snapshot");

    return async (id) => {
      await call(c, "deleteById", id);
    };
  }

  if (name === "local") {
    const c = member(provider.native(sandboxId), "client");

    return async (id) => {
      await call(c, "call", "DELETE", `/images/${encodeURIComponent(id)}`);
    };
  }

  if (name === "boxd") {
    // A fresh client: cleanup can run after the source machine is gone, when the adapter's native handle is not.
    const c = member(
      await client("@boxd-sh/sdk", "Boxd", { apiKey: process.env.BOXD_API_KEY }),
      "snapshots",
    );

    return async (id) => {
      await call(c, "delete", id);
    };
  }

  if (name === "upstash") {
    const mod: unknown = await nativeModules.load("@upstash/box");
    const c = member(mod, "Box");

    return async (id) => {
      await call(c, "deleteSnapshots", { snapshotIds: [id] });
    };
  }

  if (name === "e2b") {
    const mod: unknown = await nativeModules.load("e2b");
    const c = member(mod, "Sandbox");

    return async (id) => {
      await call(c, "deleteSnapshot", id);
    };
  }

  if (name === "daytona") {
    const c = member(await client("@daytonaio/sdk", "Daytona", undefined), "snapshot");

    return async (id) => {
      await call(c, "delete", id);
    };
  }

  if (name === "freestyle") {
    const c = member(
      member(
        await client("freestyle", "Freestyle", { apiKey: process.env.FREESTYLE_API_KEY }),
        "vms",
      ),
      "snapshots",
    );

    return async (id) => {
      await call(c, "delete", id);
    };
  }

  if (name === "tenki") {
    const c = await client("@tenkicloud/sandbox", "TenkiSandbox", {
      authToken: process.env.TENKI_API_KEY ?? process.env.TENKI_AUTH_TOKEN,
    });

    return async (id) => {
      await call(c, "deleteSnapshot", id);
    };
  }

  throw new Error("Snapshot cleanup not registered");
}

/** Name Daytona snapshots before creation for scoped timeout recovery; match the adapter's ten-minute completion budget. */
export async function createNamedDaytonaSnapshot(
  provider: Provider,
  sandboxId: string,
  name: string,
) {
  await call(provider.native(sandboxId), "createSnapshot", name, 600);

  return { id: name };
}

/** Narrow recovery query for snapshots of a sandbox whose run ownership was already established. */
export async function snapshotsFromDaytonaSandbox(sourceSandboxId: string) {
  const c = member(await client("@daytonaio/sdk", "Daytona", undefined), "snapshot");

  const pageSchema = z.object({
    items: z.array(z.object({ id: z.string(), name: z.string() })),
    totalPages: z.number(),
  });

  const items: { id: string; name: string }[] = [];

  for (let page = 1; page <= 100; page++) {
    const data = pageSchema.parse(await call(c, "list", { sourceSandboxId, page, limit: 100 }));
    items.push(...data.items);

    if (page >= data.totalPages) return items;
  }

  throw new Error("Snapshot recovery exceeded pagination bound");
}

/** Query only a source sandbox already recorded in the run ownership journal. */
export async function snapshotsFromSource(provider: string, sourceSandboxId: string) {
  if (provider !== "superserve") return snapshotsFromDaytonaSandbox(sourceSandboxId);
  const mod: unknown = await nativeModules.load("@superserve/sdk");

  return z
    .array(z.object({ id: z.string(), name: z.string().optional() }))
    .parse(await call(member(mod, "Snapshot"), "list", sourceSandboxId));
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

/** Read snapshot metadata without connecting to, activating, or requiring a live source sandbox. */
export async function inspectSnapshot(
  name: string,
  provider: Provider,
  sourceId: string,
  id: string,
): Promise<{ exists: boolean; sourceId?: string }> {
  try {
    let raw: unknown;

    switch (name) {
      case "e2b": {
        const page = await call(
          member(await nativeModules.load("e2b"), "Sandbox"),
          "listSnapshots",
          { name: id, limit: 100 },
        );

        for (let index = 0; index < 100; index++) {
          const items = z
            .array(z.object({ snapshotId: z.string() }))
            .parse(await call(page, "nextItems"));

          if (items.some((item) => item.snapshotId === id)) return { exists: true };

          if (member(page, "hasNext") === false || !items.length)
            throw new Error("Snapshot metadata not visible; absence unproven");
        }

        throw new Error("Snapshot metadata pagination exhausted");
      }

      case "daytona":
        raw = await call(
          member(await client("@daytonaio/sdk", "Daytona", undefined), "snapshot"),
          "get",
          id,
        );
        break;
      case "boxd":
        raw = await call(
          member(
            await client("@boxd-sh/sdk", "Boxd", { apiKey: process.env.BOXD_API_KEY }),
            "snapshots",
          ),
          "get",
          id,
        );
        break;
      case "tenki":
        raw = await call(
          await client("@tenkicloud/sandbox", "TenkiSandbox", {
            authToken: process.env.TENKI_API_KEY ?? process.env.TENKI_AUTH_TOKEN,
          }),
          "getSnapshot",
          id,
        );
        break;
      case "freestyle":
        raw = await call(
          member(
            member(
              await client("freestyle", "Freestyle", { apiKey: process.env.FREESTYLE_API_KEY }),
              "vms",
            ),
            "snapshots",
          ),
          "get",
          id,
        );
        break;
      case "superserve":
        raw = await call(
          member(await nativeModules.load("@superserve/sdk"), "Snapshot"),
          "get",
          id,
        );
        break;
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
        raw = list.snapshots.find((snapshot) => snapshot.id === id);

        if (!raw) throw new Error("Snapshot metadata not visible; absence unproven");
        break;
      }

      case "local": {
        const image = await call(
          member(provider.native(sourceId), "client"),
          "call",
          "GET",
          `/images/${encodeURIComponent(id)}/json`,
        );

        z.object({ Id: z.string() }).parse(image);

        return { exists: true };
      }

      default:
        throw new Error("Native snapshot metadata unavailable");
    }

    const info = snapshotInfo.parse(raw);

    if (info.id !== id && info.name !== id) throw new Error("Snapshot metadata ID mismatch");

    const parent =
      info.sourceSandboxId ?? info.sandboxId ?? info.sessionId ?? info.sourceVmId ?? info.box_id;

    // These APIs expose provenance: unreadable or cleared source fields cannot authorize deletion.
    if (["daytona", "superserve", "tenki", "freestyle", "upstash"].includes(name) && !parent)
      throw new Error("Snapshot source metadata unavailable");

    return { exists: true, ...(parent ? { sourceId: parent } : {}) };
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

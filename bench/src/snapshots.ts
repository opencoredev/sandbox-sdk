import { z } from "zod";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
const resolveNative = (name: string) =>
  import.meta.resolve(name, new URL("../../packages/sdk/package.json", import.meta.url).href);
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
  const module: unknown = await import(resolveNative(moduleName));
  const C = constructor.parse(member(module, exportName));
  return new C(options);
}
export async function snapshotCleaner(
  name: string,
  provider: Provider,
  sandboxId: string,
): Promise<(id: string) => Promise<void>> {
  if (name === "superserve") {
    const mod: unknown = await import(resolveNative("@superserve/sdk"));
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
  if (name === "upstash") {
    const mod: unknown = await import(resolveNative("@upstash/box"));
    const c = member(mod, "Box");
    return async (id) => {
      await call(c, "deleteSnapshots", { snapshotIds: [id] });
    };
  }
  if (name === "e2b") {
    const mod: unknown = await import(resolveNative("e2b"));
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
  const mod: unknown = await import(resolveNative("@superserve/sdk"));
  return z
    .array(z.object({ id: z.string(), name: z.string().optional() }))
    .parse(await call(member(mod, "Snapshot"), "list", sourceSandboxId));
}

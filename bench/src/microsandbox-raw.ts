/**
 * A Microsandbox sandbox made without the SDK adapter, for scripts/sdk-overhead.ts: the control plane
 * with plain `fetch` (the same `POST /v1/sandboxes?start=true&wait_for=running` the adapter sends), and
 * commands through the official `microsandbox` peer's own `RemoteContext`. A sandbox is admitted for use
 * and cleanup only once an answer carries this create's own owner marker in `spec.labels`.
 */
import { z } from "zod";
import { microsandboxFetch } from "./microsandbox.js";

/** The label the raw create stores its owner marker in. */
export const rawOwnerLabel = "sdk-overhead-owner";

const sandboxRecord = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  compute: z.object({ type: z.string() }).nullish(),
  spec: z.object({ labels: z.record(z.string(), z.string()).default({}) }).nullish(),
});

/** What the raw path needs from `microsandbox`: a `RemoteContext` whose sandboxes run commands. */
export interface RawPeer {
  RemoteContext: new (options: {
    url: string;
    apiKey: string;
    computeType: "standard" | "shared";
  }) => {
    readonly sandboxes: {
      get(name: string): Promise<{ exec(command: string): Promise<{ readonly code: number }> }>;
    };
  };
}

export interface RawMicrosandboxBox {
  id: string;
  exec(): Promise<void>;
  destroy(): Promise<void>;
  exists(): Promise<boolean>;
}

/** One sandbox read by name; undefined on a 404. */
async function byName(name: string) {
  const response = await microsandboxFetch(`/sandboxes/by-name/${encodeURIComponent(name)}`);

  if (response.status === 404) {
    await response.body?.cancel();

    return undefined;
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Microsandbox read failed: HTTP ${response.status}`);
  }

  return sandboxRecord.parse(await response.json());
}

export async function createRawMicrosandbox(input: {
  computeType: "standard" | "shared";
  labels: Readonly<Record<string, string>>;
  peer: RawPeer;
  admit: (box: RawMicrosandboxBox) => void;
}): Promise<RawMicrosandboxBox> {
  const owner = crypto.randomUUID();
  const name = `sdk-overhead-${crypto.randomUUID()}`;

  const box = (id: string): RawMicrosandboxBox => ({
    id,
    exec: async () => {
      const context = new input.peer.RemoteContext({
        url: (process.env.MSB_API_URL?.trim() || "https://api.microsandbox.dev").replace(
          /\/+$/,
          "",
        ),
        apiKey: process.env.MSB_API_KEY ?? "",
        computeType: input.computeType,
      });

      const result = await (await context.sandboxes.get(name)).exec("true");

      if (result.code !== 0) throw new Error(`exit ${result.code}`);
    },
    destroy: async () => {
      const response = await microsandboxFetch(`/sandboxes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });

      await response.body?.cancel();

      if (!response.ok && response.status !== 404)
        throw new Error(`Microsandbox delete failed: HTTP ${response.status}`);
    },
    exists: async () => {
      const response = await microsandboxFetch(`/sandboxes/${encodeURIComponent(id)}`);
      await response.body?.cancel();

      if (response.status === 404) return false;

      if (!response.ok) throw new Error(`Microsandbox read failed: HTTP ${response.status}`);

      return true;
    },
  });

  const query = new URLSearchParams({ start: "true", wait_for: "running", wait_timeout: "60" });
  let created: z.infer<typeof sandboxRecord> | undefined;

  try {
    const response = await microsandboxFetch(`/sandboxes?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spec: {
          source: "oci",
          reference: "node:22-bookworm",
          name,
          labels: { ...input.labels, [rawOwnerLabel]: owner },
          lifecycle: { ephemeral: false, max_duration_secs: 3600 },
        },
        compute: { type: input.computeType },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      await response.body?.cancel();

      if (response.status < 500)
        throw new Error(`Microsandbox create refused: HTTP ${response.status}`);
    } else created = sandboxRecord.parse(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Microsandbox create refused"))
      throw error;
  }

  // A lost or unreadable answer may still have made it: read the name until an owned record appears.
  const deadline = Date.now() + 180_000;
  let admitted: RawMicrosandboxBox | undefined;

  for (;;) {
    const record = created ?? (await byName(name).catch(() => undefined));
    created = undefined;

    if (record?.spec && record.spec.labels[rawOwnerLabel] === owner) {
      if (admitted === undefined) {
        admitted = box(record.id);
        input.admit(admitted);
      }

      // This create's sandbox on the other tier would time the wrong machine: it is deleted, never used.
      if (record.compute?.type !== input.computeType) {
        await admitted.destroy();
        throw new Error(
          `Microsandbox sandbox runs on ${record.compute?.type ?? "an unknown"} compute, not ${input.computeType}; it was deleted`,
        );
      }

      if (record.status === "running") return admitted;

      if (!["created", "starting"].includes(record.status))
        throw new Error(`Microsandbox sandbox did not start (${record.status})`);
    }

    if (Date.now() > deadline) throw new Error("Microsandbox sandbox did not start in time");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

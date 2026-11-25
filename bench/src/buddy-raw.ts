/**
 * Buddy's Sandboxes API with plain fetch, for `scripts/sdk-overhead.ts`: the floor the adapter is measured
 * against, and the raw creates it times. The adapter is direct HTTP with no peer SDK, so the floor is the
 * same API without it.
 */
import { z } from "zod";
import { buddyConfig, buddyWorkspaceApi } from "./connections.js";

/** The note field naming the one raw create that made a sandbox. */
export const rawOwnerField = "sdk-overhead-owner";

/** How long one raw request may take, its body included, so a stalled answer cannot hang the run. */
export const rawRequestMs = 60_000;

/** How long a raw create waits for its sandbox to run with setup done, inside the timed create. */
export const rawReadyMs = 180_000;

/** Buddy's workspace API with the run's token. A non-2xx answer throws with its status. */
export async function buddyCall(
  path: string,
  init: { method?: string; json?: object; body?: BodyInit; timeoutMs?: number } = {},
) {
  // The same workspace, token and host the adapter resolves from the environment.
  const config = buddyConfig();
  const headers = new Headers({ Authorization: `Bearer ${config.token}` });

  if (init.json !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(`${buddyWorkspaceApi(config)}${path}`, {
    method: init.method ?? "GET",
    headers,
    // Never follow a redirect: a write would be replayed, token included, at another origin.
    redirect: "error",
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
    // Covers the body too: reading it after the deadline rejects.
    signal: AbortSignal.timeout(init.timeoutMs ?? rawRequestMs),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Buddy ${path.split("/")[1]} failed: HTTP ${response.status}`), {
      status: response.status,
    });
  }

  return response;
}

/** One command to its end through `POST /sandboxes/{id}/exec`; a non-zero exit throws. */
export async function buddyRun(id: string, command: string) {
  const response = await buddyCall(`/sandboxes/${encodeURIComponent(id)}/exec`, {
    method: "POST",
    json: { command, runtime: "BASH" },
  });

  const result = z.object({ exit_code: z.number() }).parse(await response.json());

  if (result.exit_code !== 0) throw new Error(`exit ${result.exit_code}`);
}

/** One file through `POST /content/upload/{path}`, multipart, as the adapter writes it. */
export async function buddyWrite(id: string, path: string, data: Uint8Array) {
  const form = new FormData();
  const segments = path.split("/").filter(Boolean);

  form.append("file", new Blob([new Uint8Array(data)]), segments.at(-1) ?? "file");
  await (
    await buddyCall(
      `/sandboxes/${encodeURIComponent(id)}/content/upload/${segments.map(encodeURIComponent).join("/")}?userName=buddy`,
      { method: "POST", body: form },
    )
  ).body?.cancel();
}

const buddyRecord = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  status: z.string().optional(),
  setup_status: z.string().optional(),
  note: z.string().optional(),
});

const noteOwner = z.object({ [rawOwnerField]: z.string() });

/** The owner a sandbox's note names, or undefined. */
function ownerOf(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  let value: unknown;

  try {
    value = JSON.parse(note);
  } catch {
    return undefined;
  }

  const parsed = noteOwner.safeParse(value);

  return parsed.success ? parsed.data[rawOwnerField] : undefined;
}

/** A sandbox a raw create made, as `sdk-overhead.ts` times and cleans it up. */
export interface RawBuddyBox {
  id: string;
  exec(): Promise<void>;
  destroy(): Promise<void>;
  exists(): Promise<boolean>;
}

/**
 * A raw create with the adapter's defaults: Ubuntu 24.04 at the default size, a unique identifier and a
 * fresh owner marker in its note. An answer is admitted for use and cleanup only when it carries that
 * marker. A create that fails without a definite refusal may still have made one: before the failure is
 * reported, the sandbox holding this create's identifier is read and admitted when it carries the marker.
 */
export async function createRawBuddy(input: {
  labels: Readonly<Record<string, string>>;
  admit: (box: RawBuddyBox) => void;
}): Promise<RawBuddyBox> {
  const config = buddyConfig();
  const owner = crypto.randomUUID();
  const identifier = `sdk-raw-${owner.replace(/-/g, "").slice(0, 20)}`;
  const note = JSON.stringify({ ...input.labels, [rawOwnerField]: owner });

  const body = config.project
    ? { name: identifier, identifier, os: "ubuntu:24.04", note, project_name: config.project }
    : { name: identifier, identifier, os: "ubuntu:24.04", note };

  let created: z.infer<typeof buddyRecord>;

  try {
    created = buddyRecord.parse(
      await (
        await buddyCall("/sandboxes", {
          method: "POST",
          json: body,
        })
      ).json(),
    );
  } catch (error) {
    const refused = z.object({ status: z.number().min(400).max(499) }).safeParse(error).success;

    if (!refused) await recoverByIdentifier(identifier, owner, input.admit).catch(() => {});
    throw error;
  }

  const id = created.id;

  if (ownerOf(created.note) !== owner) {
    await recoverByIdentifier(identifier, owner, input.admit).catch(() => {});
    throw new Error(
      `Buddy create answered with sandbox ${id}, which this create did not make; it was left alone`,
    );
  }

  const raw = rawBox(id, () => buddyRun(id, "true"));

  // Admitted before the wait, so cleanup knows the ID even when the sandbox never runs.
  input.admit(raw);
  await untilReady(id, owner);

  return raw;
}

/** Finds the sandbox holding `identifier` and admits it for cleanup when it carries `owner`. */
async function recoverByIdentifier(
  identifier: string,
  owner: string,
  admit: (box: RawBuddyBox) => void,
) {
  const config = buddyConfig();

  const listPath = config.project
    ? `/sandboxes?project_name=${encodeURIComponent(config.project)}`
    : "/sandboxes";

  for (let read = 0; read < 5; read++) {
    if (read > 0) await new Promise((resolve) => setTimeout(resolve, 2000));

    const list = z
      .object({ sandboxes: z.array(buddyRecord).optional() })
      .parse(await (await buddyCall(listPath)).json());

    const holder = list.sandboxes?.find((s) => s.identifier === identifier);

    if (!holder) continue;

    const record = buddyRecord.parse(
      await (await buddyCall(`/sandboxes/${encodeURIComponent(holder.id)}`)).json(),
    );

    if (record.id === holder.id && ownerOf(record.note) === owner)
      admit(
        rawBox(record.id, async () => {
          throw new Error("Buddy create answer was lost");
        }),
      );

    return;
  }
}

/** One raw sandbox for `sdk-overhead.ts`: `exec` as given, and the plain delete and existence reads. */
function rawBox(id: string, exec: () => Promise<void>): RawBuddyBox {
  return {
    id,
    exec,
    destroy: async () => {
      try {
        await (
          await buddyCall(`/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" })
        ).body?.cancel();
      } catch (error) {
        if (!z.object({ status: z.literal(404) }).safeParse(error).success) throw error;
      }
    },
    exists: async () => {
      try {
        await (await buddyCall(`/sandboxes/${encodeURIComponent(id)}`)).body?.cancel();

        return true;
      } catch (error) {
        if (z.object({ status: z.literal(404) }).safeParse(error).success) return false;
        throw error;
      }
    },
  };
}

/**
 * Reads the sandbox until it runs with its setup done, as the adapter waits before its first command;
 * throws when it fails, when a read lacks this create's `owner` marker, or when {@link rawReadyMs} passes.
 */
async function untilReady(id: string, owner: string) {
  const until = Date.now() + rawReadyMs;

  for (;;) {
    const left = until - Date.now();

    if (left <= 0) throw new Error(`Buddy sandbox ${id} did not start in time`);

    const record = buddyRecord.parse(
      await (
        await buddyCall(`/sandboxes/${encodeURIComponent(id)}`, {
          timeoutMs: Math.min(rawRequestMs, left),
        })
      ).json(),
    );

    if (record.id !== id || ownerOf(record.note) !== owner)
      throw new Error(`Buddy read of ${id} answered with a sandbox this create did not make`);

    if (record.status === "RUNNING" && record.setup_status === "SUCCESS") return;

    if (record.status === "FAILED" || record.setup_status === "FAILED")
      throw new Error(`Buddy sandbox ${id} failed to start`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(200, Math.max(0, until - Date.now()))),
    );
  }
}

/**
 * Styne's REST API with plain fetch, for `scripts/sdk-overhead.ts`: the floor the adapter is measured
 * against, and the raw creates it times. The adapter is direct HTTP with no peer SDK, so the floor is the
 * same API without it.
 */
import { z } from "zod";
import { rawOwnerLabel, rawRequestMs } from "./maritime-raw.js";

/** Hosts where plain HTTP keeps the key on this machine: the loopback test fakes. */
const loopbackHosts: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The API root the run's key may go to: https, or http only on a loopback host, never with credentials. */
export function styneRoot() {
  const root = (process.env.STYNE_API_URL ?? "https://api.styne.ai").replace(/\/+$/, "");
  const url = new URL(root);

  if (url.username || url.password) throw new Error("STYNE_API_URL must not carry credentials");

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname)))
    throw new Error("STYNE_API_URL must use https; plain http is allowed only for loopback");

  return root;
}

/**
 * Styne's API with the run's key. A redirect is refused, never followed with the key or a body. A
 * non-2xx answer throws with its status.
 */
export async function styneCall(
  path: string,
  init: { method?: string; body?: BodyInit; json?: object } = {},
) {
  const response = await fetch(`${styneRoot()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${process.env.STYNE_API_KEY ?? ""}`,
      "Content-Type": init.json === undefined ? "application/octet-stream" : "application/json",
    },
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
    redirect: "error",
    // Covers the body too: reading it after the deadline rejects.
    signal: AbortSignal.timeout(rawRequestMs),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Styne ${path.split("/")[1]} failed: HTTP ${response.status}`), {
      status: response.status,
    });
  }

  return response;
}

/** One command to its end through `POST /sandboxes/{id}/commands`; a non-zero exit throws. */
export async function styneRun(id: string, command: string) {
  const response = await styneCall(`/sandboxes/${encodeURIComponent(id)}/commands`, {
    method: "POST",
    json: { argv: ["sh", "-c", command], timeoutMs: rawRequestMs },
  });

  const result = z.object({ exitCode: z.number().nullable() }).parse(await response.json());

  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`);
}

/** Styne's answer for a sandbox that is gone: 404, or 410 while it still remembers it. */
const styneGone = z.object({ status: z.union([z.literal(404), z.literal(410)]) });

const styneRecord = z.object({
  sandboxID: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

/** A sandbox a raw create made, as `sdk-overhead.ts` times and cleans it up. */
export interface RawStyneBox {
  id: string;
  exec(): Promise<void>;
  destroy(): Promise<void>;
  exists(): Promise<boolean>;
}

/**
 * A raw create with the adapter's defaults (the template, a one-hour lifetime), carrying a fresh owner
 * marker in its metadata. Styne's create answer has no metadata, so the sandbox it names is read back
 * and admitted for use and cleanup only when it carries that marker: an answer naming any other sandbox
 * is left alone. A create that fails without a 4xx refusal may still have made one, and a read-back that
 * fails or answers garbage proves nothing, so in both cases the sandbox carrying the marker is looked for
 * and admitted for cleanup before the failure is reported.
 */
export async function createRawStyne(input: {
  template: string;
  labels: Readonly<Record<string, string>>;
  admit: (box: RawStyneBox) => void;
}): Promise<RawStyneBox> {
  const owner = crypto.randomUUID();
  let id: string;

  try {
    id = styneRecord.parse(
      await (
        await styneCall("/sandboxes", {
          method: "POST",
          json: {
            templateID: input.template,
            metadata: { ...input.labels, [rawOwnerLabel]: owner },
            timeout: 3600,
          },
        })
      ).json(),
    ).sandboxID;
  } catch (error) {
    if (!z.object({ status: z.number().min(400).max(499) }).safeParse(error).success)
      await recoverByOwner(owner, input.admit).catch(() => {});
    throw error;
  }

  let record: z.infer<typeof styneRecord>;

  // An unanswered or unreadable read-back proves nothing either way, so the marker decides cleanup.
  try {
    record = styneRecord.parse(
      await (await styneCall(`/sandboxes/${encodeURIComponent(id)}`)).json(),
    );
  } catch (error) {
    await recoverByOwner(owner, input.admit).catch(() => {});
    throw error;
  }

  if (record.sandboxID !== id || record.metadata?.[rawOwnerLabel] !== owner) {
    await recoverByOwner(owner, input.admit).catch(() => {});
    throw new Error(
      `Styne create answered with sandbox ${id}, which this create did not make; it was left alone`,
    );
  }

  const box = rawBox(id, () => styneRun(id, "true"));

  input.admit(box);

  return box;
}

/** Finds the sandbox carrying `owner` and admits it for cleanup; its `exec` always fails. */
async function recoverByOwner(owner: string, admit: (box: RawStyneBox) => void) {
  const query = new URLSearchParams({
    metadata: new URLSearchParams({ [rawOwnerLabel]: owner }).toString(),
  });

  const found = z
    .array(styneRecord)
    .parse(await (await styneCall(`/sandboxes?${query}`)).json())
    .filter((s) => s.metadata?.[rawOwnerLabel] === owner);

  for (const s of found)
    admit(
      rawBox(s.sandboxID, async () => {
        throw new Error("Styne create answer was lost");
      }),
    );
}

function rawBox(id: string, exec: () => Promise<void>): RawStyneBox {
  return {
    id,
    exec,
    destroy: async () => {
      try {
        await (
          await styneCall(`/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" })
        ).body?.cancel();
      } catch (error) {
        // A second delete answers 404, an ended sandbox 410.
        if (!styneGone.safeParse(error).success) throw error;
      }
    },
    exists: async () => {
      try {
        await (await styneCall(`/sandboxes/${encodeURIComponent(id)}`)).body?.cancel();

        return true;
      } catch (error) {
        if (styneGone.safeParse(error).success) return false;
        throw error;
      }
    },
  };
}

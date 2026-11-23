/**
 * Maritime's REST API with plain fetch, for `scripts/sdk-overhead.ts`: the floor the adapter is measured
 * against, and the raw creates it times. The adapter is direct HTTP with no peer SDK, so the floor is the
 * same API without it.
 */
import { z } from "zod";

/** The metadata entry naming the one raw create that made a sandbox. */
export const rawOwnerLabel = "sdk-overhead-owner";

/** Maritime's control plane with the run's key. A non-2xx answer throws with its status and error code. */
export async function maritimeCall(
  path: string,
  init: { method?: string; json?: object; key?: string } = {},
) {
  const root = (process.env.MARITIME_API_URL ?? "https://api.maritime.sh").replace(/\/+$/, "");
  const headers = new Headers({ Authorization: `Bearer ${process.env.MARITIME_API_KEY ?? ""}` });

  if (init.json !== undefined) headers.set("Content-Type", "application/json");

  if (init.key !== undefined) headers.set("Idempotency-Key", init.key);

  const response = await fetch(`${root}/v1${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });

  if (!response.ok) {
    const code = z.object({ code: z.string() }).safeParse(await response.json().catch(() => null));

    throw Object.assign(
      new Error(`Maritime ${path.split("/")[1]} failed: HTTP ${response.status}`),
      {
        status: response.status,
        // Only one of Maritime's own codes: an echoed credential never becomes evidence.
        code:
          code.success && /^[a-z][a-z_]{0,63}$/.test(code.data.code) ? code.data.code : undefined,
      },
    );
  }

  return response;
}

const maritimeSandbox = z.object({
  id: z.string(),
  state: z.string(),
  dataPlaneUrl: z.string(),
  secret: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

type MaritimeSandbox = z.infer<typeof maritimeSandbox>;

/** One sandbox's data plane: its URL and secret, read once per sandbox. */
const planes = new Map<string, Promise<MaritimeSandbox>>();

export function maritimePlane(id: string) {
  let plane = planes.get(id);

  if (!plane) {
    plane = maritimeCall(`/sandboxes/${encodeURIComponent(id)}`).then(async (response) =>
      maritimeSandbox.parse(await response.json()),
    );
    planes.set(id, plane);
  }

  return plane;
}

/** One command to its end through `POST {dataPlaneUrl}/commands` (JSON, not a stream); a non-zero exit throws. */
export async function maritimeRun(id: string, command: string) {
  const plane = await maritimePlane(id);

  const response = await fetch(`${plane.dataPlaneUrl}/commands`, {
    method: "POST",
    headers: { "X-Maritime-Token": plane.secret, "Content-Type": "application/json" },
    body: JSON.stringify({ cmd: ["sh", "-c", command], cwd: "/" }),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Maritime command failed: HTTP ${response.status}`);
  }

  const result = z.object({ exitCode: z.number().nullable() }).parse(await response.json());

  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`);
}

/** Maritime's answer for a sandbox that is gone: 404, or an ended record while it remembers it. */
const maritimeGone = z.object({ status: z.literal(404) });

/** A sandbox a raw create made, as `sdk-overhead.ts` times and cleans it up. */
export interface RawMaritimeBox {
  id: string;
  exec(): Promise<void>;
  destroy(): Promise<void>;
  exists(): Promise<boolean>;
}

/**
 * A raw create with the adapter's defaults: the template, a one-hour time limit, a fresh idempotency key,
 * and a new key after each capacity refusal, which Maritime answers before anything runs. Each create
 * carries a fresh owner marker in its metadata, and an answer is admitted for use and cleanup only when
 * it carries that marker: an answer naming any other sandbox, such as an operator's, is left alone.
 */
export async function createRawMaritime(input: {
  template: string;
  labels: Readonly<Record<string, string>>;
  admit: (box: RawMaritimeBox) => void;
}): Promise<RawMaritimeBox> {
  const owner = crypto.randomUUID();
  let created: MaritimeSandbox | undefined;

  for (let attempt = 0; !created; attempt++)
    try {
      created = maritimeSandbox.parse(
        await (
          await maritimeCall("/sandboxes", {
            method: "POST",
            key: crypto.randomUUID(),
            json: {
              from: input.template,
              metadata: { ...input.labels, [rawOwnerLabel]: owner },
              timeLimitSeconds: 3600,
            },
          })
        ).json(),
      );
    } catch (error) {
      const refused = z.object({ code: z.literal("out_of_capacity") }).safeParse(error).success;

      if (!refused || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(20_000, 2000 * 2 ** attempt)));
    }

  const id = created.id;

  if (created.metadata?.[rawOwnerLabel] !== owner)
    throw new Error(
      `Maritime create answered with sandbox ${id}, which this create did not make; it was left alone`,
    );

  planes.set(id, Promise.resolve(created));

  const raw: RawMaritimeBox = {
    id,
    exec: () => maritimeRun(id, "true"),
    destroy: async () => {
      try {
        await (
          await maritimeCall(`/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" })
        ).body?.cancel();
      } catch (error) {
        // A repeated end answers the ended sandbox; an unknown one 404.
        if (!maritimeGone.safeParse(error).success) throw error;
      }
    },
    exists: async () => {
      const state = z
        .object({ state: z.string() })
        .parse(await (await maritimeCall(`/sandboxes/${encodeURIComponent(id)}`)).json()).state;

      return state !== "ended";
    },
  };

  input.admit(raw);

  return raw;
}

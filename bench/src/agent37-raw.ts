/**
 * Agent 37's Sandbox API with plain fetch, for `scripts/sdk-overhead.ts`: the floor the adapter is
 * measured against, and the raw creates it times. The adapter is direct HTTP with no peer SDK, so the
 * floor is the same API without it.
 */
import { z } from "zod";
import { agent37Config, endpoint } from "./connections.js";
import { agent37Instance, agent37InstanceList } from "./existence.js";
import { rawOwnerLabel, rawReadyMs, rawRequestMs } from "./maritime-raw.js";

/** The exec host, as the adapter resolves it: AGENT37_EXEC_URL, else Agent 37's own. */
function execRoot() {
  return endpoint(process.env.AGENT37_EXEC_URL ?? "https://sandbox.agent37.app");
}

/**
 * Agent 37's control plane (Bearer key) or exec plane (`X-Agent37-Key`) with the run's key. A redirect
 * is refused, never followed with the key or a body. A non-2xx answer throws with its status.
 */
export async function agent37Call(
  path: string,
  init: { method?: string; json?: object; plane?: "control" | "exec"; timeoutMs?: number } = {},
) {
  // The same key and host the adapter resolves from the environment.
  const { apiKey, baseUrl } = agent37Config();
  const exec = init.plane === "exec";

  const headers = new Headers(
    exec ? { "X-Agent37-Key": apiKey } : { Authorization: `Bearer ${apiKey}` },
  );

  if (init.json !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(`${exec ? execRoot() : baseUrl}/v1${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
    redirect: "error",
    // Covers the body too: reading it after the deadline rejects.
    signal: AbortSignal.timeout(init.timeoutMs ?? rawRequestMs),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(
      new Error(`Agent 37 ${path.split("/")[1]} failed: HTTP ${response.status}`),
      {
        status: response.status,
      },
    );
  }

  return response;
}

/** One command to its end through the exec host's `POST /instances/{id}/exec`; a non-zero exit throws. */
export async function agent37Run(id: string, command: string) {
  const response = await agent37Call(`/instances/${encodeURIComponent(id)}/exec`, {
    method: "POST",
    plane: "exec",
    json: { command, user: "root" },
  });

  const result = z.object({ exit_code: z.number() }).parse(await response.json());

  if (result.exit_code !== 0) throw new Error(`exit ${result.exit_code}`);
}

const ownerOf = (instance: z.infer<typeof agent37Instance>) => instance.metadata?.[rawOwnerLabel];

/** A sandbox a raw create made, as `sdk-overhead.ts` times and cleans it up. */
export interface RawAgent37Box {
  id: string;
  exec(): Promise<void>;
  destroy(): Promise<void>;
  exists(): Promise<boolean>;
}

/**
 * A raw create with the adapter's defaults (a default instance at the default size) on `template`, with
 * a fresh owner marker in its metadata. An answer is admitted for use and cleanup only when it carries
 * that marker, and is timed until it runs, as the adapter waits before its first command. A create that
 * fails without a 4xx refusal may still have made one, so the instance carrying the marker is looked
 * for and admitted for cleanup before the failure is reported.
 */
export async function createRawAgent37(input: {
  template: string;
  labels: Readonly<Record<string, string>>;
  admit: (box: RawAgent37Box) => void;
}): Promise<RawAgent37Box> {
  const owner = crypto.randomUUID();
  let created: z.infer<typeof agent37Instance>;

  try {
    created = agent37Instance.parse(
      await (
        await agent37Call("/instances", {
          method: "POST",
          json: {
            template: input.template,
            type: "default",
            name: "sdk-overhead",
            metadata: { ...input.labels, [rawOwnerLabel]: owner },
          },
        })
      ).json(),
    );
  } catch (error) {
    if (!z.object({ status: z.number().min(400).max(499) }).safeParse(error).success)
      await recoverByOwner(owner, input.admit).catch(() => {});
    throw error;
  }

  const id = created.id;

  if (ownerOf(created) !== owner) {
    await recoverByOwner(owner, input.admit).catch(() => {});
    throw new Error(
      `Agent 37 create answered with instance ${id}, which this create did not make; it was left alone`,
    );
  }

  const box = rawBox(id, () => agent37Run(id, "true"));

  // Admitted before the wait, so cleanup knows the ID even when the instance never runs.
  input.admit(box);

  if (created.status !== "running") await untilRunning(id, owner);

  return box;
}

/** Finds the instance carrying `owner` and admits it for cleanup; its `exec` always fails. */
async function recoverByOwner(owner: string, admit: (box: RawAgent37Box) => void) {
  const found = agent37InstanceList
    .parse(await (await agent37Call("/instances")).json())
    .data.filter((instance) => ownerOf(instance) === owner);

  for (const instance of found)
    admit(
      rawBox(instance.id, async () => {
        throw new Error("Agent 37 create answer was lost");
      }),
    );
}

/** Statuses on the way to `running`, which the wait polls through, as the adapter's does. */
const coming: ReadonlySet<string> = new Set([
  "provisioning",
  "starting",
  "restarting",
  "updating",
  "waking",
]);

/**
 * Reads the instance until it runs; throws when it reaches any other status, when a read lacks this
 * create's `owner` marker, or when {@link rawReadyMs} passes.
 */
async function untilRunning(id: string, owner: string) {
  const until = Date.now() + rawReadyMs;

  for (;;) {
    const left = until - Date.now();

    if (left <= 0) throw new Error(`Agent 37 instance ${id} did not start in time`);

    const instance = agent37Instance.parse(
      await (
        await agent37Call(`/instances/${encodeURIComponent(id)}`, {
          timeoutMs: Math.min(rawRequestMs, left),
        })
      ).json(),
    );

    if (instance.id !== id || ownerOf(instance) !== owner)
      throw new Error(`Agent 37 read of ${id} answered with an instance this create did not make`);

    if (instance.status === "running") return;

    if (!coming.has(instance.status))
      throw new Error(`Agent 37 instance ${id} is ${instance.status}, not running`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, Math.max(0, until - Date.now()))),
    );
  }
}

/** Agent 37's answer for an instance that is gone. */
const agent37Gone = z.object({ status: z.literal(404) });

function rawBox(id: string, exec: () => Promise<void>): RawAgent37Box {
  return {
    id,
    exec,
    destroy: async () => {
      try {
        await (
          await agent37Call(`/instances/${encodeURIComponent(id)}`, { method: "DELETE" })
        ).body?.cancel();
      } catch (error) {
        // A second delete answers 404.
        if (!agent37Gone.safeParse(error).success) throw error;
      }
    },
    exists: async () => {
      try {
        const instance = agent37Instance.parse(
          await (await agent37Call(`/instances/${encodeURIComponent(id)}`)).json(),
        );

        return instance.status !== "deleting" && instance.status !== "deleted";
      } catch (error) {
        if (agent37Gone.safeParse(error).success) return false;
        throw error;
      }
    },
  };
}

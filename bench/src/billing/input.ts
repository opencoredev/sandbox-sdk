import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
import { isMissingFile } from "../files.js";
import { ambiguousAllocations, journalAppSchema } from "../modal-apps.js";

const sampleSchema = z.object({
  provider: z.string(),
  scenario: z.string(),
  sandboxId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  phases: z.record(z.string(), z.number()).optional(),
});

const resourceSchema = z.object({ provider: z.string(), id: z.string(), kind: z.string() });

/** The journaled App a sandbox was created in (Modal per-attempt Apps), with its sandbox count. */
export type OwnedApp = {
  name: string;
  appId: string | null;
  sandboxes: readonly string[];
  /** Creates in the App whose outcome is unknown: each may have left a sandbox not in `sandboxes`. */
  ambiguous: number;
};

export type OwnedSandbox = {
  provider: string;
  id: string;
  scenarios: Set<string>;
  startedAt: string | null;
  /** The latest end of any of its samples, a failed or cold one included: not a stop. */
  finishedAt: string | null;
  /**
   * When the sandbox was known to be stopped: the end of a destroy row that recorded the
   * provider's confirmed stop (`confirmedStopMs`, Modal). Null without one.
   */
  confirmedStopAt: string | null;
  /** Null when the journal names no App: the sandbox is in the adapter's default App. */
  app: OwnedApp | null;
};

/**
 * Extract one object at a time from a named top-level JSON array. Memory is bounded by one row.
 * With `optional`, a file without the array yields nothing; a truncated array still throws.
 */
export async function* jsonObjects(
  path: string,
  key: string,
  { optional = false }: { optional?: boolean } = {},
): AsyncGenerator<unknown> {
  let depth = 0,
    quoted = false,
    escaped = false,
    token = "",
    pendingKey = "",
    active = false,
    found = false,
    done = false;

  let object = "";

  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    for (const char of chunk) {
      if (done) continue;

      if (active && depth === 2 && !/[\s,\]{]/.test(char))
        throw new Error(`${key} must contain objects`);

      if (active && depth >= 3) object += char;

      if (quoted) {
        if (depth === 1) token += char;

        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') {
          quoted = false;

          if (depth === 1) pendingKey = z.string().parse(JSON.parse(token));
        }

        continue;
      }

      if (char === '"') {
        quoted = true;

        if (depth === 1) token = '"';
        continue;
      }

      if (char === "{" || char === "[") {
        if (char === "[" && depth === 1 && pendingKey === key) {
          active = true;
          found = true;
        }

        if (active && depth === 2) {
          if (char !== "{") throw new Error(`${key} must contain objects`);
          object = "{";
        }

        depth++;
      } else if (char === "}" || char === "]") {
        if (active && depth === 3 && char === "}") {
          yield JSON.parse(object);
          object = "";
        }

        if (active && depth === 2 && char === "]") {
          active = false;
          done = true;
        }

        depth--;
      } else if (depth === 1 && char === ",") pendingKey = "";
    }
  }

  if (optional && !found) return;

  if (!found || !done) throw new Error(`Missing or truncated ${key} array in ${path}`);
}

async function exists(path: string) {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export async function readRun(
  directory: string,
  onUnidentified?: (sample: z.infer<typeof sampleSchema>) => void,
): Promise<OwnedSandbox[]> {
  const owned = new Map<string, OwnedSandbox>();

  const add = (provider: string, id: string) => {
    const key = JSON.stringify([provider, id]);
    let value = owned.get(key);

    if (!value) {
      value = {
        provider,
        id,
        scenarios: new Set(),
        startedAt: null,
        finishedAt: null,
        confirmedStopAt: null,
        app: null,
      };
      owned.set(key, value);
    }

    return value;
  };

  const ndjson = join(directory, "samples.ndjson");

  async function* samples() {
    if (await exists(ndjson)) {
      for await (const line of createInterface({
        input: createReadStream(ndjson),
        crlfDelay: Infinity,
      }))
        if (line.trim()) yield JSON.parse(line);
    } else if (await exists(join(directory, "results.json")))
      yield* jsonObjects(join(directory, "results.json"), "samples");
    else if (!(await exists(join(directory, "ownership.json"))))
      throw new Error("Report requires results.json, samples.ndjson or ownership.json");
  }

  for await (const raw of samples()) {
    const sample = sampleSchema.parse(raw);

    if (!sample.sandboxId) {
      onUnidentified?.(sample);
      continue;
    }

    const value = add(sample.provider, sample.sandboxId);
    value.scenarios.add(sample.scenario);

    if (!value.startedAt || sample.startedAt < value.startedAt) value.startedAt = sample.startedAt;

    if (!value.finishedAt || sample.finishedAt > value.finishedAt)
      value.finishedAt = sample.finishedAt;
    const stop = sample.phases?.confirmedStopMs;

    // The row ends once the provider has reported the stop, so its end bounds the stop from above.
    if (
      stop !== undefined &&
      Number.isFinite(stop) &&
      (!value.confirmedStopAt || sample.finishedAt > value.confirmedStopAt)
    )
      value.confirmedStopAt = sample.finishedAt;
  }

  const journal = join(directory, "ownership.json");

  if (await exists(journal)) {
    for await (const raw of jsonObjects(journal, "resources")) {
      const resource = resourceSchema.parse(raw);

      if (resource.kind === "sandbox" || resource.kind === "snapshot-source")
        add(resource.provider, resource.id);
    }

    // Apps stay journaled after cleanup, so every sandbox created in one is attributed to it.
    for await (const raw of jsonObjects(journal, "apps", { optional: true })) {
      const app = journalAppSchema.parse(raw);

      const owner: OwnedApp = {
        name: app.name,
        appId: app.appId,
        sandboxes: app.sandboxes,
        ambiguous: ambiguousAllocations(app),
      };

      for (const id of app.sandboxes) add(app.provider, id).app = owner;
    }
  }

  return [...owned.values()];
}

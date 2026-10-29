import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";

const sampleSchema = z.object({
  provider: z.string(),
  scenario: z.string(),
  sandboxId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});

const resourceSchema = z.object({ provider: z.string(), id: z.string(), kind: z.string() });

export type OwnedSandbox = {
  provider: string;
  id: string;
  scenarios: Set<string>;
  startedAt: string | null;
  finishedAt: string | null;
};

/** Extract one object at a time from a named top-level JSON array. Memory is bounded by one row. */
export async function* jsonObjects(path: string, key: string): AsyncGenerator<unknown> {
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

  if (!found || !done) throw new Error(`Missing or truncated ${key} array in ${path}`);
}

async function exists(path: string) {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
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
      value = { provider, id, scenarios: new Set(), startedAt: null, finishedAt: null };
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
  }

  const journal = join(directory, "ownership.json");

  if (await exists(journal))
    for await (const raw of jsonObjects(journal, "resources")) {
      const resource = resourceSchema.parse(raw);

      if (resource.kind === "sandbox" || resource.kind === "snapshot-source")
        add(resource.provider, resource.id);
    }

  return [...owned.values()];
}

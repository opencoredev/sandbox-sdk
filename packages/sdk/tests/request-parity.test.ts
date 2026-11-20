// Adding `resolveConfig` must not change a single request an adapter makes. `request-matrix.ts`
// records every request and provider-SDK call for a matrix of options and environments; this
// tree's recording must equal the one made from `base`, the commit before `resolveConfig`.
//
// The recording of `base` is kept in fixtures/request-matrix.base.json, so a shallow clone checks
// it too. Where git has `base`, the test also records it afresh, so the file cannot drift. After a
// provider SDK upgrade, regenerate the file from `base`, never from this tree:
//   dir=$(mktemp -d node_modules/.request-matrix-XXXX)
//   git archive <base> src | tar -x -C "$dir"
//   bun tests/request-matrix.ts "$dir/src" > tests/fixtures/request-matrix.base.json
//   bunx oxfmt tests/fixtures/request-matrix.base.json
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const base = "788477654e06dad556c8e970d8383edad523e7fa";
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "tests", "fixtures", "request-matrix.base.json");

/** Each configuration's events: requests, provider-SDK calls, step results and errors. */
const recordingSchema = z.record(z.string(), z.object({ events: z.array(z.json()) }));

type Recording = z.infer<typeof recordingSchema>;

async function saved(): Promise<Recording> {
  return recordingSchema.parse(JSON.parse(await readFile(fixture, "utf8")));
}

function record(source: string): Recording {
  const run = spawnSync("bun", ["tests/request-matrix.ts", source], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (run.error) throw run.error;

  if (run.status !== 0) throw new Error(`request-matrix exited ${run.status}: ${run.stderr}`);

  return recordingSchema.parse(JSON.parse(run.stdout));
}

const baseAvailable =
  spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root }).status === 0;

describe("adapter requests are unchanged since the commit before resolveConfig", () => {
  test("this tree sends what base sent, for every provider and configuration", async () => {
    const expected = await saved();
    const recorded = record(join(root, "src"));

    expect(Object.keys(recorded)).toEqual(Object.keys(expected));
    expect(recorded).toEqual(expected);
  }, 60_000);

  test.skipIf(!baseAvailable)(
    "the saved recording is base's own",
    async () => {
      // Inside node_modules, so base's imports of provider SDKs resolve to this package's installs.
      const dir = await mkdtemp(join(root, "node_modules", ".request-matrix-"));

      try {
        const archive = spawnSync("git", ["archive", base, "src"], {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
        });

        if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);

        const extract = spawnSync("tar", ["-x", "-C", dir], { input: archive.stdout });

        if (extract.status !== 0) throw new Error(`tar failed: ${extract.stderr}`);

        expect(record(join(dir, "src"))).toEqual(await saved());
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

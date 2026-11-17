import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { sweepProviders } from "../../src/realistic/cli.js";
import { attributionFor, emptyRecord } from "../../src/realistic/slots.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** An attempt record for `run` whose sandbox `id` was never confirmed deleted. */
function unconfirmed(run: string, id: string, provider = "baseten") {
  const record = emptyRecord(
    {
      runId: run,
      attemptId: `${run}-${id}`,
      provider,
      // SAFETY: emptyRecord reads only `profiles`, and an unknown profile falls back to its kind.
      manifest: { profiles: {} } as never,
      manifestSha256: null,
      profileName: "build",
      track: "default",
      variant: "headline",
      batch: 0,
      slot: { index: 0, id: "build-default" },
      seed: 1,
      slotStartedAt: 0,
    },
    "error",
    "volume delete failed",
    0,
    attributionFor(provider).attribution,
  );

  record.sandboxIds = [id];
  record.deletionConfirmed = false;

  return record;
}

describe("realistic sweep", () => {
  it("destroys again an unconfirmed attempt's sandbox that the listing no longer shows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sweep-"));
    dirs.push(dir);
    const run = "rw-sweep";

    await writeFile(
      join(dir, "attempts.jsonl"),
      [unconfirmed(run, "gone-1"), unconfirmed("rw-other", "other-1")]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    const destroyed: string[] = [];
    const provider = { ...memory(), name: "baseten" };

    provider.destroy = async (id) => {
      destroyed.push(id);
    };

    const notes: object[] = [];

    const result = await sweepProviders(
      run,
      [
        {
          name: "baseten",
          provider,
          attribution: attributionFor("baseten").attribution,
          settlementMs: null,
          paddingMs: 0,
        },
      ],
      async (entry) => {
        notes.push(entry);
      },
      dir,
    );

    expect(destroyed).toEqual(["gone-1"]);
    expect(notes).toContainEqual({
      kind: "leftover",
      provider: "baseten",
      id: "gone-1",
      removed: true,
    });
    expect(result.undeleted).toBe(0);
  });
});

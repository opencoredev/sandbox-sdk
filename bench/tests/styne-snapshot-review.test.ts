import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { reapRun } from "../src/recovery.js";
import { parseV2 } from "../src/v2-config.js";
import { fingerprintOf } from "../src/connections.js";
import { bound } from "./native-fakes.js";

test("Styne recovery deletes only this run's journaled snapshot", async () => {
  const out = await mkdtemp(join(tmpdir(), "styne-snapshot-review-"));
  const run = "snapshot-review";
  const sourceId = "vmReview";
  const ownedName = "bench-snapshot-review-12345678";
  const foreignName = "operator-copy";
  const snapshots = new Set([ownedName, foreignName]);
  const deleted: string[] = [];
  vi.stubEnv("STYNE_API_URL", "https://review.invalid");
  vi.stubEnv("STYNE_API_KEY", "review-placeholder");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;

    if (path === `/sandboxes/${sourceId}/snapshots`)
      return Response.json([...snapshots].map((name) => ({ name, sandboxID: sourceId })));
    const name = decodeURIComponent(path.slice("/snapshots/".length));

    if (!path.startsWith("/snapshots/") || !snapshots.has(name))
      return new Response(null, { status: 404 });

    if (init?.method !== "DELETE") return Response.json({ name, sandboxID: sourceId });
    deleted.push(name);
    snapshots.delete(name);

    return new Response(null, { status: 204 });
  });

  const proof = {
    sourceId,
    runLabel: run,
    sdkLabel: "1",
    verifiedAt: "2026-11-23T12:00:00.000Z",
  };

  const provider = bound({ ...memory(), name: "styne" });

  try {
    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        connectionFingerprints: { styne: await fingerprintOf(provider) },
        resources: [
          {
            provider: "styne",
            kind: "snapshot-source",
            id: sourceId,
            parent: null,
            snapshotProof: proof,
          },
          {
            provider: "styne",
            kind: "snapshot",
            id: ownedName,
            parent: sourceId,
            snapshotProof: proof,
          },
        ],
      }),
    );
    await reapRun(
      [{ kind: "ready", name: "styne", cloud: false, region: null, provider }],
      parseV2(["--providers", "styne", "--run", run, "--out", out, "--timeout-ms", "1000"]),
      (value) => value,
    );
    expect(deleted).toEqual([ownedName]);
    expect([...snapshots]).toEqual([foreignName]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(out, { recursive: true, force: true });
  }
});

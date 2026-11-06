import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAttempt, type AttemptPlan } from "../../src/realistic/attempt.js";
import { evaluateCheck } from "../../src/realistic/checks.js";
import { harnessManifestFromFrozen } from "../../src/realistic/frozen.js";
import { systemClock } from "../../src/realistic/gaps.js";
import { fileArtifacts } from "../../src/realistic/prepare.js";
import { attemptRecordSchema } from "../../src/realistic/record.js";
import { parseResourceRead, resourcesBetween } from "../../src/realistic/resources.js";
import { buildFixture, type Fixture } from "./fixture.js";
import { hostProvider, type HostProvider } from "./host-provider.js";

let fixture: Fixture;
let host: HostProvider;

beforeAll(async () => {
  fixture = await buildFixture();
  host = await hostProvider();
});

afterAll(async () => {
  await host.dispose();
  await fixture.cleanup();
});

const plan = (overrides: Partial<AttemptPlan> = {}): AttemptPlan => ({
  runId: "rw-upload",
  attemptId: `rw-upload-${Math.random().toString(36).slice(2, 8)}`,
  provider: { name: "host", provider: host },
  manifest: fixture.manifest,
  manifestSha256: null,
  profileName: "fix-and-test",
  track: "same-machine",
  variant: "headline",
  batch: 0,
  slot: { index: 0, id: "fix-and-test/same-machine" },
  seed: 7,
  slotStartedAt: Date.now(),
  ...overrides,
});

describe("artifacts uploaded through the SDK", () => {
  it("uploads in chunks, joins and hash-checks inside the sandbox, and completes", async () => {
    // The fixture's cache directory holds each artifact under its sha256: a local store.
    const names = await readdir(fixture.cacheDir);

    const source = fileArtifacts(
      new Map(names.map((name) => [name, join(fixture.cacheDir, name)])),
    );

    const { record } = await runAttempt(plan(), {
      clock: systemClock,
      signal: new AbortController().signal,
      blobs: fixture.blobs,
      // No URL is reachable: every artifact must arrive through files.write.
      prepare: {
        cacheBaseUrl: "http://127.0.0.1:9/unreachable",
        upload: { source, chunkBytes: 512 },
      },
      attribution: "per-sandbox",
    });

    attemptRecordSchema.parse(JSON.parse(JSON.stringify(record)));
    expect(record.completion).toEqual({ kind: "completed" });

    expect(
      record.downloads.map((d) => [d.role, d.url.startsWith("sdk-upload:"), d.hashOk]),
    ).toEqual([
      ["toolchain", true, true],
      ["dependency-cache", true, true],
    ]);

    // The host provider runs on this machine: its CPU and memory are readable.
    expect(record.resources?.cpuQuota).toBeGreaterThan(0);
    expect(record.resources?.memoryGiB).toBeGreaterThan(0);
  });

  it("refuses an artifact whose local copy does not match its hash", async () => {
    const [name] = await readdir(fixture.cacheDir);
    const corrupt = join(fixture.root, "corrupt");
    await writeFile(corrupt, "not the artifact");
    const source = fileArtifacts(new Map([[name ?? "", corrupt]]));
    await expect(source.read(name ?? "")).rejects.toThrow(/has hash/);
  });

  it("runs in the provider's own working directory when given one", async () => {
    const names = await readdir(fixture.cacheDir);

    const source = fileArtifacts(
      new Map(names.map((name) => [name, join(fixture.cacheDir, name)])),
    );

    const { record } = await runAttempt(plan({ workdir: "/workspace/elsewhere" }), {
      clock: systemClock,
      signal: new AbortController().signal,
      blobs: fixture.blobs,
      prepare: { cacheBaseUrl: "http://127.0.0.1:9/unreachable", upload: { source } },
      attribution: "per-sandbox",
    });

    expect(record.completion).toEqual({ kind: "completed" });
  });
});

describe("resource reads", () => {
  it("takes the CPU quota from cpu.max, memory from the lower of the limit and MemTotal", () => {
    const read = parseResourceRead(
      [
        "q=400000 100000",
        "m=8589934592",
        "t=16000000",
        "u=5000000",
        "p=900",
        "h=100",
        "n=32",
        "a=x86_64",
      ].join("\n"),
    );

    expect(read).toEqual({
      cpuQuota: 4,
      cpuQuotaSource: "cgroup",
      memoryGiB: 8,
      arch: "x86_64",
      cpuSeconds: 5,
      source: "cgroup",
    });
  });

  it("falls back to online CPUs, MemTotal and /proc/stat in a VM without limits", () => {
    const read = parseResourceRead(
      ["q=max 100000", "m=max", "t=8388608", "u=", "p=1200", "h=100", "n=2", "a=aarch64"].join(
        "\n",
      ),
    );

    expect(read).toEqual({
      cpuQuota: 2,
      cpuQuotaSource: "online-cpus",
      memoryGiB: 8,
      arch: "aarch64",
      cpuSeconds: 12,
      source: "proc-stat",
    });
  });

  it("reports CPU time only between two reads from the same source", () => {
    const start = parseResourceRead("q=max\nt=8388608\nu=1000000\nn=4");
    const end = parseResourceRead("q=max\nt=8388608\nu=91000000\nn=4");
    expect(resourcesBetween(start, end)?.cpuSeconds).toBe(90);
    expect(
      resourcesBetween(start, parseResourceRead("q=max\nt=8388608\np=10\nh=100\nn=4"))?.cpuSeconds,
    ).toBeNull();
    expect(resourcesBetween(null, null)).toBeNull();
  });
});

const frozen = "/home/leo/agents/realistic-workloads/manifest.json";

const reference =
  "/home/leo/agents/realistic-workloads/fit/offline/fix-and-test/fix-and-test-4cpu-8g";

describe.skipIf(!existsSync(frozen) || !existsSync(reference))("the frozen SBX-95 manifest", () => {
  it("converts to a valid harness manifest whose test checks pass on the reference run's reports", () => {
    const manifest = harnessManifestFromFrozen(readFileSync(frozen, "utf8"));
    const profile = manifest.profiles["fix-and-test"];

    for (const [id, file, exit] of [
      ["test-a", "report-a.json", 1],
      ["test-b", "report-b.json", 0],
    ] as const) {
      const check = profile?.steps.find((step) => step.id === id)?.check;

      if (!check) throw new Error(`No check for ${id}`);

      const result = evaluateCheck(check, {
        exitCode: exit,
        timedOut: false,
        output: "",
        testReport: readFileSync(join(reference, file), "utf8"),
        fileHashes: {},
        paths: { workdir: "/w" },
      });

      expect(result.failures).toEqual([]);
      // The timing-sensitive test ran and is recorded, not counted.
      expect(result.excluded.map((outcome) => outcome.status)).toEqual(["passed"]);
    }

    const build = manifest.profiles.build?.steps ?? [];

    expect(build.find((step) => step.id === "build")?.check.postconditions.exists).toEqual([
      "repo/build/app.bundle.min.js",
      "repo/build/external_api.min.js",
      "repo/build/alwaysontop.min.js",
    ]);

    // The frozen check is "exists and non-empty".
    expect(build.at(-1)?.op).toEqual({
      kind: "shell",
      script:
        "test -s build/app.bundle.min.js && test -s build/external_api.min.js && test -s build/alwaysontop.min.js",
    });
  });

  it("fails a run whose failing tests differ from the frozen ones, or whose report has suite errors", () => {
    const manifest = harnessManifestFromFrozen(readFileSync(frozen, "utf8"));

    const check = manifest.profiles["fix-and-test"]?.steps.find(
      (step) => step.id === "test-a",
    )?.check;

    if (!check) throw new Error("No test-a check");

    const report = z
      .looseObject({
        testResults: z.array(
          z.looseObject({
            message: z.string().optional(),
            assertionResults: z.array(z.looseObject({ status: z.string(), fullName: z.string() })),
          }),
        ),
      })
      .parse(JSON.parse(readFileSync(join(reference, "report-a.json"), "utf8")));

    // Same counts, different identities: one frozen failure passes, an unrelated test fails.
    const swapped = structuredClone(report);
    const tests = swapped.testResults.flatMap((file) => file.assertionResults);

    const frozenFailure = tests.find(
      (t) => t.fullName === "utils/looseEqual compares arrays correctly",
    );

    const other = tests.find((t) => t.status === "passed" && !t.fullName.includes("exponential"));

    if (!frozenFailure || !other) throw new Error("fixture");
    frozenFailure.status = "passed";
    other.status = "failed";

    const observe = (text: string) =>
      evaluateCheck(check, {
        exitCode: 1,
        timedOut: false,
        output: "",
        testReport: text,
        fileHashes: {},
        paths: { workdir: "/w" },
      });

    expect(observe(JSON.stringify(swapped)).failures.map((f) => f.kind)).toContain("failing-tests");

    const broken = structuredClone(report);
    const first = broken.testResults[0];

    if (!first) throw new Error("fixture");
    first.message = "Error: Failed to load url ./missing (resolved id: ./missing)";
    expect(observe(JSON.stringify(broken)).failures.map((f) => f.kind)).toContain("test-report");
  });
});

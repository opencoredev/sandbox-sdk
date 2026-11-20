import { describe, expect, it } from "vitest";
import {
  agentLoopScenarios,
  cycleCount,
  cyclePlan,
  cycleProjectFiles,
  cycleTestCount,
  expectedCycleDigest,
  expectedParallelDigest,
  expectedRapidDigest,
  expectedRapidReplies,
  expectedRepoDigest,
  parallelSlots,
  rapidCommand,
  rapidSteps,
  repoFileCount,
  repoFixture,
  repoNeedleCount,
} from "../src/expanded/agent-loops.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import { sha256Hex, tapCounts } from "../src/expanded/verify-kit.js";
import {
  applyLocalEdit,
  describeContract,
  flipHex,
  seedA,
  seedB,
  sh,
  writeLocalTree,
} from "./expanded-contract.js";

function scenario(id: string): ExpandedScenario {
  const found = agentLoopScenarios.find((s) => s.id === id);

  if (found === undefined) throw new Error(`missing scenario ${id}`);

  return found;
}

const localSeed = 31_337;

describe("agent loop scenarios", () => {
  it("registers four lower-is-better timed loops", () => {
    expect(agentLoopScenarios.map((s) => [s.id, s.category, s.unit, s.better])).toEqual([
      ["loop-rapid-exec-50", "agent-loops", "s", "lower"],
      ["loop-parallel-exec-16", "agent-loops", "s", "lower"],
      ["loop-grep-find-repo", "agent-loops", "s", "lower"],
      ["loop-patch-test-cycle", "agent-loops", "s", "lower"],
    ]);
  });

  it("chains each rapid reply into the next, so replies differ by seed and by step", () => {
    const replies = expectedRapidReplies(seedA);

    expect(replies).toHaveLength(rapidSteps);
    expect(new Set(replies).size).toBe(rapidSteps);
    expect(replies[0]).toMatch(/^step-0-[0-9a-f]{16}$/);
    expect(expectedRapidReplies(seedB)[0]).not.toBe(replies[0]);
  });

  it("hides exactly 12 needles across 150 files, in distinct files", () => {
    const fixture = repoFixture(seedA);

    expect(Object.keys(fixture.files)).toHaveLength(repoFileCount);
    expect(fixture.matches).toHaveLength(repoNeedleCount);
    expect(new Set(fixture.matches.map((m) => m.split(":")[0])).size).toBe(repoNeedleCount);
  });

  it("plans eight cycles that each change the flag and the test expectation", () => {
    const plan = cyclePlan(seedA);

    expect(plan).toHaveLength(cycleCount);

    for (const iteration of plan)
      for (const edit of iteration.edits) expect(edit.find).not.toBe(edit.replace);
  });
});

describeContract({
  scenario: scenario("loop-rapid-exec-50"),
  valid: (seed) => ({ seed, steps: rapidSteps, seconds: 2.5, digest: expectedRapidDigest(seed) }),
  tampered: [
    ["steps", rapidSteps - 1],
    ["steps", rapidSteps + 1],
  ],
  proofField: "digest",
  valueField: "seconds",
});

describeContract({
  scenario: scenario("loop-parallel-exec-16"),
  valid: (seed) => ({
    seed,
    slots: parallelSlots,
    seconds: 0.6,
    digest: expectedParallelDigest(seed),
    repliesDigest: expectedParallelDigest(seed),
  }),
  tampered: [
    ["slots", parallelSlots - 1],
    ["repliesDigest", flipHex(expectedParallelDigest(seedA))],
  ],
  proofField: "digest",
  valueField: "seconds",
});

describeContract({
  scenario: scenario("loop-grep-find-repo"),
  valid: (seed) => ({
    seed,
    files: repoFileCount,
    matchCount: repoNeedleCount,
    seconds: 0.7,
    digest: expectedRepoDigest(seed),
  }),
  tampered: [
    ["files", repoFileCount - 1],
    ["matchCount", repoNeedleCount - 1],
  ],
  proofField: "digest",
  valueField: "seconds",
});

describeContract({
  scenario: scenario("loop-patch-test-cycle"),
  valid: (seed) => ({ seed, cycles: cycleCount, seconds: 3, digest: expectedCycleDigest(seed) }),
  tampered: [["cycles", cycleCount - 1]],
  proofField: "digest",
  valueField: "seconds",
});

describe("agent loop commands run locally", () => {
  it("the 50 rapid commands reproduce the expected reply chain", { timeout: 30_000 }, () => {
    const dir = writeLocalTree({});
    let previous = `seed-${localSeed}`;
    const replies: string[] = [];

    for (let step = 0; step < rapidSteps; step++) {
      previous = sh(rapidCommand(previous, step), dir).stdout;
      replies.push(previous);
    }

    expect(replies).toEqual(expectedRapidReplies(localSeed));
  });

  it("the guest's sort | sha256sum of 16 slot tokens matches the expected digest", () => {
    const dir = writeLocalTree({});

    const out = sh(
      `for i in $(seq 0 ${parallelSlots - 1}); do printf '%s' "seed:${localSeed}:slot:$i" | sha256sum | cut -c1-32; done | LC_ALL=C sort | sha256sum | cut -c1-64`,
      dir,
    );

    expect(out.stdout).toBe(expectedParallelDigest(localSeed));
  });

  it("grep finds exactly the planted needles at the planted lines", () => {
    const fixture = repoFixture(localSeed);
    const root = writeLocalTree(fixture.files);

    expect(sh("find . -type f -name '*.ts' | wc -l", root).stdout).toBe(String(repoFileCount));

    const grep = sh(
      "grep -rnoE 'NEEDLE_[0-9a-f]{8}' --include='*.ts' . | LC_ALL=C sort",
      root,
    ).stdout;

    const matches = grep
      .split("\n")
      .map((line) => line.replace(/^\.\//, ""))
      .sort();

    expect(matches).toEqual(fixture.matches);
    expect(expectedRepoDigest(localSeed)).toBe(sha256Hex(`${localSeed}\n${matches.join("\n")}`));
  });

  it(
    "eight edit-then-test cycles pass and reproduce the expected chain digest",
    { timeout: 60_000 },
    () => {
      const root = writeLocalTree(cycleProjectFiles());
      let digest = `cycle-${localSeed}`;

      cyclePlan(localSeed).forEach((iteration, i) => {
        for (const edit of iteration.edits) applyLocalEdit(root, edit);

        const run = sh(
          `node --test --test-reporter=tap feature.test.mjs && node probe.mjs ${iteration.probe}`,
          root,
        );

        expect(run.status, run.output).toBe(0);
        expect(tapCounts(run.stdout)).toEqual({ pass: cycleTestCount, fail: 0 });

        digest = sha256Hex(
          `${digest}:${i}:${cycleTestCount}:${run.stdout.split("\n").at(-1)?.trim() ?? ""}`,
        );
      });

      expect(digest).toBe(expectedCycleDigest(localSeed));
    },
  );
});

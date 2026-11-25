import { describe, expect, it } from "vitest";
import {
  agentTaskScenarios,
  codemodFilesChanged,
  codemodModuleCount,
  codemodProjectFiles,
  codemodReplacements,
  codemodTargetName,
  expectedCodemodDigest,
  expectedLogTriage,
  expectedNodeDigest,
  expectedPyDigest,
  logAnalyzerScript,
  logGeneratorScript,
  logLineCount,
  nodeFailingBefore,
  nodeFixes,
  nodeProjectFiles,
  nodeTestCount,
  pyFailingBefore,
  pyFix,
  pyProjectFiles,
  pyTestCount,
  unittestCounts,
} from "../src/expanded/agent-tasks.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import { tapCounts } from "../src/expanded/verify-kit.js";
import {
  applyLocalEdit,
  describeContract,
  seedA,
  seedB,
  sh,
  writeLocalTree,
} from "./expanded-contract.js";

function scenario(id: string): ExpandedScenario {
  const found = agentTaskScenarios.find((s) => s.id === id);

  if (found === undefined) throw new Error(`missing scenario ${id}`);

  return found;
}

const localSeed = 77_001;

describe("agent task scenarios", () => {
  it("registers four lower-is-better timed tasks", () => {
    expect(agentTaskScenarios.map((s) => [s.id, s.category, s.unit, s.better])).toEqual([
      ["agent-fix-bug-node", "agent-tasks", "s", "lower"],
      ["agent-fix-bug-python", "agent-tasks", "s", "lower"],
      ["agent-refactor-codemod", "agent-tasks", "s", "lower"],
      ["agent-debug-log-triage", "agent-tasks", "s", "lower"],
    ]);
  });

  it("parses TAP and unittest summaries", () => {
    expect(tapCounts("ok 1\n# tests 5\n# pass 3\n# fail 2\n")).toEqual({ pass: 3, fail: 2 });
    expect(tapCounts("no summary")).toEqual({ pass: -1, fail: -1 });
    expect(unittestCounts("....\nRan 4 tests in 0.001s\n\nOK\n")).toEqual({ ran: 4, failed: 0 });
    expect(unittestCounts("Ran 4 tests in 0.002s\n\nFAILED (failures=1, errors=1)\n")).toEqual({
      ran: 4,
      failed: 2,
    });
    expect(unittestCounts("Traceback")).toEqual({ ran: -1, failed: -1 });
  });

  it("names the codemod target after the seed", () => {
    expect(codemodTargetName(255)).toBe("score_ff");
    expect(codemodTargetName(seedA)).not.toBe(codemodTargetName(seedB));
  });

  it("injects a spike that makes its service the top failure for every seed", () => {
    for (let seed = 0; seed < 12; seed++) {
      const triage = expectedLogTriage(seed * 0x9e37_79b9);

      expect(triage.culpritService).toBe(triage.injected);
      expect(triage.errorCount).toBeGreaterThan(150);
    }
  });
});

describeContract({
  scenario: scenario("agent-fix-bug-node"),
  valid: (seed) => ({
    seed,
    failedBefore: true,
    failingBefore: nodeFailingBefore,
    passedTests: nodeTestCount,
    failingAfter: 0,
    seconds: 1.25,
    digest: expectedNodeDigest(seed),
  }),
  tampered: [
    ["failedBefore", false],
    ["failingBefore", 0],
    ["passedTests", nodeTestCount - 1],
    ["failingAfter", 1],
  ],
  proofField: "digest",
  valueField: "seconds",
});

describeContract({
  scenario: scenario("agent-fix-bug-python"),
  valid: (seed) => ({
    seed,
    failedBefore: true,
    failingBefore: pyFailingBefore,
    passedTests: pyTestCount,
    failingAfter: 0,
    seconds: 1.1,
    digest: expectedPyDigest(seed),
  }),
  tampered: [
    ["failedBefore", false],
    ["failingBefore", 0],
    ["passedTests", pyTestCount - 1],
    ["failingAfter", 1],
  ],
  proofField: "digest",
  valueField: "seconds",
});

describeContract({
  scenario: scenario("agent-refactor-codemod"),
  valid: (seed) => ({
    seed,
    modules: codemodModuleCount,
    renamed: codemodTargetName(seed),
    filesChanged: codemodFilesChanged,
    replacements: codemodReplacements,
    staleReferences: false,
    seconds: 0.9,
    digest: expectedCodemodDigest(seed),
  }),
  tampered: [
    ["modules", codemodModuleCount - 1],
    ["renamed", "legacyScore"],
    ["renamed", codemodTargetName(seedB)],
    ["filesChanged", codemodFilesChanged - 1],
    ["replacements", codemodReplacements - 1],
    ["staleReferences", true],
  ],
  proofField: "digest",
  valueField: "seconds",
});

describeContract({
  scenario: scenario("agent-debug-log-triage"),
  valid: (seed) => {
    const triage = expectedLogTriage(seed);

    return {
      seed,
      totalLines: logLineCount,
      culpritService: triage.culpritService,
      errorCount: triage.errorCount,
      p95LatencyMs: triage.p95LatencyMs,
      seconds: 0.8,
      digest: triage.digest,
    };
  },
  tampered: [
    ["totalLines", logLineCount - 1],
    ["culpritService", expectedLogTriage(seedA).culpritService === "auth" ? "billing" : "auth"],
    ["errorCount", expectedLogTriage(seedA).errorCount + 1],
    ["p95LatencyMs", expectedLogTriage(seedA).p95LatencyMs + 1],
  ],
  proofField: "digest",
  valueField: "seconds",
});

describe("agent task projects run locally", () => {
  it(
    "Node: tests fail before the two fixes, pass after, and verify.mjs prints the expected digest",
    { timeout: 30_000 },
    () => {
      const root = writeLocalTree(nodeProjectFiles(localSeed));
      const test = "node --test --test-reporter=tap test/money.test.js test/cart.test.js";
      const before = sh(test, root);

      expect(before.status).not.toBe(0);
      expect(tapCounts(before.stdout)).toEqual({
        pass: nodeTestCount - nodeFailingBefore,
        fail: nodeFailingBefore,
      });

      for (const fix of nodeFixes) applyLocalEdit(root, fix);

      const after = sh(test, root);

      expect(after.status, after.output).toBe(0);
      expect(tapCounts(after.stdout)).toEqual({ pass: nodeTestCount, fail: 0 });

      const verify = JSON.parse(sh(`node verify.mjs ${localSeed}`, root).stdout);

      expect(verify).toMatchObject({
        seed: localSeed,
        carts: 48,
        digest: expectedNodeDigest(localSeed),
      });
    },
  );

  it(
    "Python: unittest fails before the fix, passes after, and verify.py prints the expected digest",
    { timeout: 30_000 },
    () => {
      const root = writeLocalTree(pyProjectFiles(localSeed));
      const test = "PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -t .";
      const before = sh(test, root);

      expect(before.status).not.toBe(0);
      expect(unittestCounts(before.output)).toEqual({ ran: pyTestCount, failed: pyFailingBefore });

      applyLocalEdit(root, pyFix);
      const after = sh(test, root);

      expect(after.status, after.output).toBe(0);
      expect(unittestCounts(after.output)).toEqual({ ran: pyTestCount, failed: 0 });

      const verify = JSON.parse(
        sh(`PYTHONDONTWRITEBYTECODE=1 python3 verify.py ${localSeed}`, root).stdout,
      );

      expect(verify).toMatchObject({
        seed: localSeed,
        rows: 3000,
        digest: expectedPyDigest(localSeed),
      });
    },
  );

  it(
    "codemod renames every reference and verify.mjs prints the expected digest",
    { timeout: 30_000 },
    () => {
      const root = writeLocalTree(codemodProjectFiles(localSeed));
      const target = codemodTargetName(localSeed);

      expect(sh("grep -rlw legacyScore src | wc -l", root).stdout).toBe(
        String(codemodFilesChanged),
      );

      const codemod = JSON.parse(sh(`node codemod.mjs src legacyScore ${target}`, root).stdout);

      expect(codemod).toEqual({ files: codemodFilesChanged, replacements: codemodReplacements });
      expect(sh("grep -rlw legacyScore src", root).status).toBe(1);
      expect(sh("grep -rl legacyScoreVersion src | wc -l", root).stdout).toBe(
        String(codemodFilesChanged),
      );

      const verify = JSON.parse(sh(`node verify.mjs ${localSeed}`, root).stdout);

      expect(verify).toEqual({
        seed: localSeed,
        modules: codemodModuleCount,
        renamed: target,
        digest: expectedCodemodDigest(localSeed),
      });
    },
  );

  it("log generator and analyzer agree with the host's triage", { timeout: 30_000 }, () => {
    const root = writeLocalTree({
      "gen.mjs": logGeneratorScript,
      "analyze.mjs": logAnalyzerScript,
    });

    expect(
      sh(`node gen.mjs ${localSeed} app.jsonl && wc -l < app.jsonl`, root)
        .stdout.split("\n")
        .at(-1)
        ?.trim(),
    ).toBe(String(logLineCount));

    const analysis = JSON.parse(sh(`node analyze.mjs ${localSeed} app.jsonl`, root).stdout);
    const expected = expectedLogTriage(localSeed);

    expect(analysis).toEqual({
      seed: localSeed,
      totalLines: logLineCount,
      culpritService: expected.culpritService,
      errorCount: expected.errorCount,
      p95LatencyMs: expected.p95LatencyMs,
      digest: expected.digest,
    });
  });
});

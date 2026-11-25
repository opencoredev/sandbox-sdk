import { z } from "zod";
import { command, quote } from "../workloads.js";
import type { ExpandedScenario, VerifyResult } from "./types.js";
import {
  decode,
  hexDigest,
  memo,
  outcomeOf,
  positiveSeconds,
  rng32,
  secondsSince,
  seedField,
  sha256Hex,
  tapCounts,
  wrongSeed,
  writeTree,
  type ProjectEdit,
} from "./verify-kit.js";

/**
 * Agent loop scenarios: the many small round trips an agent makes, run back to back or at once.
 * Each step's reply is computed in the guest from the seed, the host chains the replies into a
 * digest, and the verifier recomputes that digest from the seed alone.
 */

// ---------------------------------------------------------------------------------------------
// loop-rapid-exec-50
// ---------------------------------------------------------------------------------------------

/** Sequential commands in one rapid loop. */
export const rapidSteps = 50;

/** Step `step`'s command: hash the previous reply with the step number, in the guest. */
export function rapidCommand(previous: string, step: number): string {
  return `h=$(printf '%s' ${quote(`${previous}:${step}`)} | sha256sum | cut -c1-16) && echo "step-${step}-$h"`;
}

function rapidStart(seed: number): string {
  return `seed-${seed >>> 0}`;
}

function chainDigest(seed: number, replies: readonly string[]): string {
  return sha256Hex(`${seed >>> 0}\n${replies.join("\n")}`);
}

/** The replies a correct guest gives, in order: each depends on the one before. */
export function expectedRapidReplies(seed: number): readonly string[] {
  const replies: string[] = [];
  let previous = rapidStart(seed);

  for (let step = 0; step < rapidSteps; step++) {
    previous = `step-${step}-${sha256Hex(`${previous}:${step}`).slice(0, 16)}`;
    replies.push(previous);
  }

  return replies;
}

export const expectedRapidDigest = memo((seed: number) =>
  chainDigest(seed, expectedRapidReplies(seed)),
);

const rapidReport = z.strictObject({
  seed: seedField,
  steps: z.number().int(),
  seconds: positiveSeconds,
  digest: hexDigest,
});

function verifyRapid(raw: string, seed: number): VerifyResult {
  const reply = decode(rapidReport, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.steps !== rapidSteps)
    return { ok: false, reason: `ran ${data.steps} steps, want ${rapidSteps}` };

  if (data.digest !== expectedRapidDigest(seed))
    return { ok: false, reason: "chain digest does not match the seed" };

  return {
    ok: true,
    value: data.seconds,
    proof: data.digest,
    details: { steps: data.steps, msPerStep: (data.seconds * 1000) / data.steps },
  };
}

const loopRapidExec: ExpandedScenario = {
  id: "loop-rapid-exec-50",
  category: "agent-loops",
  label: "50 commands in a row",
  description:
    "Runs 50 short commands one after another, each hashing the previous reply in the guest, as a tool-calling agent does.",
  unit: "s",
  better: "lower",
  async run(box, ctx) {
    const replies: string[] = [];
    let previous = rapidStart(ctx.seed);
    const started = performance.now();

    for (let step = 0; step < rapidSteps; step++) {
      previous = await command(box, rapidCommand(previous, step), ctx.timeoutMs);
      replies.push(previous);
    }

    const raw = JSON.stringify({
      seed: ctx.seed >>> 0,
      steps: replies.length,
      seconds: secondsSince(started),
      digest: chainDigest(ctx.seed, replies),
    });

    return outcomeOf("loop-rapid-exec-50", verifyRapid(raw, ctx.seed));
  },
  verifyOutput: verifyRapid,
};

// ---------------------------------------------------------------------------------------------
// loop-parallel-exec-16
// ---------------------------------------------------------------------------------------------

const parallelRoot = "/workspace/bench-par";

/** Concurrent commands in one parallel burst. */
export const parallelSlots = 16;

function slotSource(seed: number, slot: number): string {
  return `seed:${seed >>> 0}:slot:${slot}`;
}

/** Slot `slot`'s command: derive its token in the guest, write it to the slot file, and print it. */
function slotCommand(seed: number, slot: number): string {
  return (
    `t=$(printf '%s' ${quote(slotSource(seed, slot))} | sha256sum | cut -c1-32) && ` +
    `printf '%s\\n' "$t" > ${parallelRoot}/slot-${slot} && printf '%s' "$t"`
  );
}

/** SHA-256 of the sorted tokens, one per line, as `sort | sha256sum` prints it in the guest. */
function tokensDigest(tokens: readonly string[]): string {
  const sorted = [...tokens].sort();

  return sha256Hex(`${sorted.join("\n")}\n`);
}

export const expectedParallelDigest = memo((seed: number) =>
  tokensDigest(
    Array.from({ length: parallelSlots }, (_, slot) =>
      sha256Hex(slotSource(seed, slot)).slice(0, 32),
    ),
  ),
);

const parallelReport = z.strictObject({
  seed: seedField,
  slots: z.number().int(),
  seconds: positiveSeconds,
  digest: hexDigest,
  repliesDigest: hexDigest,
});

function verifyParallel(raw: string, seed: number): VerifyResult {
  const reply = decode(parallelReport, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.slots !== parallelSlots)
    return { ok: false, reason: `found ${data.slots} slot files, want ${parallelSlots}` };

  const expected = expectedParallelDigest(seed);

  if (data.digest !== expected) return { ok: false, reason: "slot files do not match the seed" };

  if (data.repliesDigest !== expected)
    return { ok: false, reason: "command replies do not match the seed" };

  return { ok: true, value: data.seconds, proof: data.digest, details: { slots: data.slots } };
}

const loopParallelExec: ExpandedScenario = {
  id: "loop-parallel-exec-16",
  category: "agent-loops",
  label: "16 commands at once",
  description:
    "Starts 16 commands in one sandbox at the same time, each deriving a token and writing its own file, then checks every file.",
  unit: "s",
  better: "lower",
  async run(box, ctx) {
    await command(box, `rm -rf ${parallelRoot} && mkdir -p ${parallelRoot}`, ctx.timeoutMs);
    const started = performance.now();

    const tokens = await Promise.all(
      Array.from({ length: parallelSlots }, (_, slot) =>
        command(box, slotCommand(ctx.seed, slot), ctx.timeoutMs),
      ),
    );

    const [count = "", filesDigest = ""] = (
      await command(
        box,
        `ls ${parallelRoot} | wc -l && cat ${parallelRoot}/slot-* | LC_ALL=C sort | sha256sum | cut -c1-64`,
        ctx.timeoutMs,
      )
    ).split("\n");

    const seconds = secondsSince(started);
    await box.run(`rm -rf ${parallelRoot}`, { timeoutMs: ctx.timeoutMs });

    const raw = JSON.stringify({
      seed: ctx.seed >>> 0,
      slots: Number(count.trim()),
      seconds,
      digest: filesDigest.trim(),
      repliesDigest: tokensDigest(tokens),
    });

    return outcomeOf("loop-parallel-exec-16", verifyParallel(raw, ctx.seed));
  },
  verifyOutput: verifyParallel,
};

// ---------------------------------------------------------------------------------------------
// loop-grep-find-repo
// ---------------------------------------------------------------------------------------------

const repoRoot = "/workspace/bench-repo";

/** Files in the generated repo, and seeded needles hidden in them. */
export const repoFileCount = 150;
export const repoNeedleCount = 12;
const repoDecoyCount = 10;
const repoPackages = ["core", "api", "web", "cli", "shared"] as const;
const repoDirs = ["lib", "util", "feature"] as const;

const repoStems = [
  "cache",
  "client",
  "config",
  "events",
  "format",
  "loader",
  "parser",
  "queue",
  "router",
  "store",
] as const;

interface RepoFixture {
  readonly files: Readonly<Record<string, string>>;
  /** `path:line:token` for every needle, sorted. */
  readonly matches: readonly string[];
}

function repoPath(index: number): string {
  const pkg = repoPackages[Math.floor(index / 30)] ?? "core";
  const dir = repoDirs[Math.floor(index / 10) % 3] ?? "lib";
  const stem = repoStems[index % 10] ?? "cache";

  return `packages/${pkg}/src/${dir}/${stem}.ts`;
}

function repoSource(next: () => number, path: string): string[] {
  const name = path.split("/").at(-1)?.replace(".ts", "") ?? "mod";

  const lines = [
    `import { assert } from "../../shared/assert.js";`,
    "",
    `export interface ${name}Options {`,
    `  readonly limit: number;`,
    `  readonly label: string;`,
    "}",
    "",
  ];

  const functions = 3 + (next() % 3);

  for (let f = 0; f < functions; f++)
    lines.push(
      `export function ${name}Step${f}(input: number, options: ${name}Options): number {`,
      `  assert(input >= 0, "${name} input must be positive");`,
      `  return (input * ${next() % 997}) % Math.max(1, options.limit);`,
      "}",
      "",
    );

  return lines;
}

/** Distinct indexes below `limit`, picked by `next`. */
function pickDistinct(
  next: () => number,
  count: number,
  limit: number,
  taken: Set<number>,
): number[] {
  const picked: number[] = [];

  while (picked.length < count) {
    const index = next() % limit;

    if (taken.has(index)) continue;

    taken.add(index);
    picked.push(index);
  }

  return picked;
}

/** The seeded repo: 150 TypeScript files, 12 with a `NEEDLE_<hex>` marker and 10 with near-miss decoys. */
export const repoFixture = memo((seed: number): RepoFixture => {
  const next = rng32(seed ^ 0x9e9);

  const sources = Array.from({ length: repoFileCount }, (_, index) =>
    repoSource(next, repoPath(index)),
  );

  const taken = new Set<number>();
  const matches: string[] = [];

  pickDistinct(next, repoNeedleCount, repoFileCount, taken).forEach((fileIndex, k) => {
    const lines = sources[fileIndex] ?? [];
    const at = 2 + (next() % (lines.length - 2));
    const token = `NEEDLE_${sha256Hex(`${seed >>> 0}:needle:${k}`).slice(0, 8)}`;
    lines.splice(at, 0, `// TODO(${token}): revisit before the next release`);
    matches.push(`${repoPath(fileIndex)}:${at + 1}:${token}`);
  });

  for (const fileIndex of pickDistinct(next, repoDecoyCount, repoFileCount, taken)) {
    const hex = sha256Hex(`${seed >>> 0}:decoy:${fileIndex}`).slice(0, 8);
    sources[fileIndex]?.splice(1, 0, `// needle_${hex} and NEEDLE-${hex} are not markers`);
  }

  const files = Object.fromEntries(
    sources.map((lines, index) => [repoPath(index), `${lines.join("\n")}\n`]),
  );

  return { files, matches: matches.sort() };
});

export const expectedRepoDigest = memo((seed: number) =>
  sha256Hex(`${seed >>> 0}\n${repoFixture(seed).matches.join("\n")}`),
);

const repoReport = z.strictObject({
  seed: seedField,
  files: z.number().int(),
  matchCount: z.number().int(),
  seconds: positiveSeconds,
  digest: hexDigest,
});

function verifyRepo(raw: string, seed: number): VerifyResult {
  const reply = decode(repoReport, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.files !== repoFileCount)
    return { ok: false, reason: `found ${data.files} files, want ${repoFileCount}` };

  if (data.matchCount !== repoNeedleCount)
    return { ok: false, reason: `found ${data.matchCount} needles, want ${repoNeedleCount}` };

  if (data.digest !== expectedRepoDigest(seed))
    return { ok: false, reason: "matches do not match the seed" };

  return {
    ok: true,
    value: data.seconds,
    proof: data.digest,
    details: { files: data.files, matches: data.matchCount },
  };
}

const grepMatch = /^\.\/(.+):(\d+):(NEEDLE_[0-9a-f]{8})$/;

const loopGrepFindRepo: ExpandedScenario = {
  id: "loop-grep-find-repo",
  category: "agent-loops",
  label: "Search a repo",
  description:
    "Searches a seeded 150-file repo with grep and find, then reads each matching file to confirm the 12 hidden markers.",
  unit: "s",
  better: "lower",
  async run(box, ctx) {
    await writeTree(box, repoRoot, repoFixture(ctx.seed).files, ctx.timeoutMs);
    const started = performance.now();

    const fileCount = Number(
      await command(box, `find ${repoRoot} -type f -name '*.ts' | wc -l`, ctx.timeoutMs),
    );

    const grep = await command(
      box,
      `cd ${repoRoot} && grep -rnoE 'NEEDLE_[0-9a-f]{8}' --include='*.ts' . | LC_ALL=C sort`,
      ctx.timeoutMs,
    );

    const matches: string[] = [];

    for (const line of grep.split("\n")) {
      const match = grepMatch.exec(line);

      if (match === null) continue;

      const [, path = "", lineNumber = "", token = ""] = match;
      const text = await box.files.read(`${repoRoot}/${path}`);

      if (!(text.split("\n")[Number(lineNumber) - 1] ?? "").includes(token))
        throw new Error(`${path}:${lineNumber} does not contain ${token}`);

      matches.push(`${path}:${lineNumber}:${token}`);
    }

    const seconds = secondsSince(started);
    await box.run(`rm -rf ${repoRoot}`, { timeoutMs: ctx.timeoutMs });

    const raw = JSON.stringify({
      seed: ctx.seed >>> 0,
      files: fileCount,
      matchCount: matches.length,
      seconds,
      digest: sha256Hex(`${ctx.seed >>> 0}\n${matches.sort().join("\n")}`),
    });

    return outcomeOf("loop-grep-find-repo", verifyRepo(raw, ctx.seed));
  },
  verifyOutput: verifyRepo,
};

// ---------------------------------------------------------------------------------------------
// loop-patch-test-cycle
// ---------------------------------------------------------------------------------------------

const cycleRoot = "/workspace/bench-cycle";

/** Edit-then-test iterations in one cycle run. */
export const cycleCount = 8;
const cycleTestInput = 7;

interface CycleStep {
  readonly rate: number;
  readonly enabled: boolean;
  readonly probe: number;
}

function applyFeature(step: Pick<CycleStep, "rate" | "enabled">, x: number): number {
  return step.enabled ? x * step.rate + 1 : x - step.rate;
}

const cycleSteps = memo((seed: number): readonly CycleStep[] => {
  const next = rng32(seed ^ 0xc1c1e);

  return Array.from({ length: cycleCount }, (_, i) => ({
    rate: 2 + (next() % 97),
    enabled: i % 2 === 0,
    probe: 10 + (next() % 1000),
  }));
});

const initialCycle = { rate: 0, enabled: false } as const;

function configLine(step: Pick<CycleStep, "rate" | "enabled">): string {
  return `export const CONFIG = { rate: ${step.rate}, enabled: ${step.enabled} };`;
}

function expectedLine(step: Pick<CycleStep, "rate" | "enabled">): string {
  return `const EXPECTED = ${applyFeature(step, cycleTestInput)};`;
}

/** The project the cycle edits: a feature flag module, its test, and a probe that prints `apply(x)`. */
export function cycleProjectFiles() {
  return {
    "package.json": `${JSON.stringify({ name: "bench-cycle", private: true, type: "module" }, null, 2)}\n`,
    "feature.mjs": `${configLine(initialCycle)}

export function apply(x) {
  return CONFIG.enabled ? x * CONFIG.rate + 1 : x - CONFIG.rate;
}
`,
    "feature.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "./feature.mjs";

${expectedLine(initialCycle)}

test("apply follows the configured rate and flag", () => {
  assert.equal(apply(${cycleTestInput}), EXPECTED);
});

test("apply is deterministic", () => {
  assert.equal(apply(3), apply(3));
});
`,
    "probe.mjs": `import { apply } from "./feature.mjs";\n\nconsole.log(apply(Number(process.argv[2])));\n`,
  };
}

/** Tests in the cycle project; every iteration must pass all of them. */
export const cycleTestCount = 2;

function cycleLink(previous: string, iteration: number, passed: number, probed: string): string {
  return sha256Hex(`${previous}:${iteration}:${passed}:${probed}`);
}

/** One iteration: the edits to apply, then the probe input whose `apply` result is the iteration's proof. */
export interface CycleIteration {
  readonly edits: readonly ProjectEdit[];
  readonly probe: number;
}

/** The seeded iterations, each moving the flag and the test expectation from the previous state. */
export const cyclePlan = memo((seed: number): readonly CycleIteration[] => {
  let current: Pick<CycleStep, "rate" | "enabled"> = initialCycle;

  return cycleSteps(seed).map((step) => {
    const edits = [
      { path: "feature.mjs", find: configLine(current), replace: configLine(step) },
      { path: "feature.test.mjs", find: expectedLine(current), replace: expectedLine(step) },
    ];

    current = step;

    return { edits, probe: step.probe };
  });
});

export const expectedCycleDigest = memo((seed: number) => {
  let digest = `cycle-${seed >>> 0}`;

  cycleSteps(seed).forEach((step, i) => {
    digest = cycleLink(digest, i, cycleTestCount, String(applyFeature(step, step.probe)));
  });

  return digest;
});

const cycleReport = z.strictObject({
  seed: seedField,
  cycles: z.number().int(),
  seconds: positiveSeconds,
  digest: hexDigest,
});

function verifyCycle(raw: string, seed: number): VerifyResult {
  const reply = decode(cycleReport, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.cycles !== cycleCount)
    return { ok: false, reason: `ran ${data.cycles} cycles, want ${cycleCount}` };

  if (data.digest !== expectedCycleDigest(seed))
    return { ok: false, reason: "cycle digest does not match the seed" };

  return {
    ok: true,
    value: data.seconds,
    proof: data.digest,
    details: { cycles: data.cycles, msPerCycle: (data.seconds * 1000) / data.cycles },
  };
}

const loopPatchTestCycle: ExpandedScenario = {
  id: "loop-patch-test-cycle",
  category: "agent-loops",
  label: "Edit and test, 8 times",
  description:
    "Edits a feature flag and its test expectation, then runs node --test, eight times over, as an agent iterating on a change.",
  unit: "s",
  better: "lower",
  async run(box, ctx) {
    await command(box, `rm -rf ${cycleRoot} && mkdir -p ${cycleRoot}`, ctx.timeoutMs);
    await box.files.write(
      Object.fromEntries(
        Object.entries(cycleProjectFiles()).map(([path, text]) => [`${cycleRoot}/${path}`, text]),
      ),
    );
    const started = performance.now();
    let digest = `cycle-${ctx.seed >>> 0}`;
    let cycles = 0;

    for (const iteration of cyclePlan(ctx.seed)) {
      for (const edit of iteration.edits) await box.files.edit(`${cycleRoot}/${edit.path}`, edit);

      const output = await command(
        box,
        `cd ${cycleRoot} && node --test --test-reporter=tap feature.test.mjs && node probe.mjs ${iteration.probe}`,
        ctx.timeoutMs,
      );

      const counts = tapCounts(output);

      if (counts.fail !== 0) throw new Error(`cycle ${cycles}: ${counts.fail} tests failed`);

      digest = cycleLink(digest, cycles, counts.pass, output.split("\n").at(-1)?.trim() ?? "");
      cycles += 1;
    }

    const seconds = secondsSince(started);
    await box.run(`rm -rf ${cycleRoot}`, { timeoutMs: ctx.timeoutMs });

    return outcomeOf(
      "loop-patch-test-cycle",
      verifyCycle(JSON.stringify({ seed: ctx.seed >>> 0, cycles, seconds, digest }), ctx.seed),
    );
  },
  verifyOutput: verifyCycle,
};

export const agentLoopScenarios: readonly ExpandedScenario[] = [
  loopRapidExec,
  loopParallelExec,
  loopGrepFindRepo,
  loopPatchTestCycle,
];

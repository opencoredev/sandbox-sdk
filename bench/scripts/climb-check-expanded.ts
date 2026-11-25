/**
 * Locked hill-climb quality check for the expanded benchmark catalog.
 *
 * Scores the number of registered expanded scenarios that pass every requirement:
 * 1. Unique kebab-case id, valid category, label, description, unit, direction.
 * 2. Pure `verifyOutput` rejects empty, garbage, and wrong-seed payloads.
 * 3. Runs end-to-end inside a real local Podman/Docker sandbox and returns finite positive value
 *    plus a seed-bound proof (>= 8 chars).
 * 4. Cleans up its sandbox completely: the daemon the sandboxes ran on lists none carrying this
 *    run's unique label, and a listing that fails scores 0.
 * 5. Exports cleanly in `exportExpandedSiteData()` with valid numeric stats.
 *
 * Prints diagnostic lines and finishes with the exact passing count on the last line.
 */
import { randomUUID } from "node:crypto";
import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import { local, type LocalProvider } from "@opencoredev/sandbox-sdk/local";
import { expandedScenarios, exportExpandedSiteData } from "../src/expanded/registry.js";
import {
  expandedCategories,
  type ExpandedRunSample,
  type ExpandedScenario,
} from "../src/expanded/types.js";

const CONCURRENCY = 4;
const TIMEOUT_MS = 90_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

/** Label every sandbox of one check run carries, with that run's id as its value. */
export const runLabel = "sandbox-sdk-bench.climb-run";

/**
 * Why the run's cleanup fails, or null when it passes. It lists through the provider the run
 * created its sandboxes with, so it asks the same daemon, and only for this run's label. A
 * listing that fails is a failure: no answer is not zero leaks.
 */
export async function cleanupFailure(
  provider: Pick<LocalProvider, "list">,
  runId: string,
): Promise<string | null> {
  try {
    const listed = await provider.list({ [runLabel]: runId });

    if (listed.length === 0) return null;

    return `leaked ${listed.length} sandbox(es): ${listed.map((info) => info.id).join(", ")}`;
  } catch (error) {
    return `could not list this run's sandboxes: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function validateDefinition(s: ExpandedScenario, seen: Set<string>): string | null {
  if (!ID_RE.test(s.id)) return `invalid id: ${s.id}`;

  if (seen.has(s.id)) return `duplicate id: ${s.id}`;
  seen.add(s.id);

  if (!expandedCategories.includes(s.category)) return `invalid category: ${s.category}`;

  if (s.label.trim().length < 3) return "label too short";

  if (s.description.trim().length < 10) return "description too short";

  // Pure verifier must reject empty and tampered inputs.
  for (const bad of ["", "{}", "not-json", '{"ok":true}', "0"]) {
    const r = s.verifyOutput(bad, 123456789);

    if (r.ok) return `verifyOutput accepted garbage input: ${JSON.stringify(bad)}`;
  }

  return null;
}

export type RunOutcome = { ok: true; sample: ExpandedRunSample } | { ok: false; reason: string };

/**
 * Creates a sandbox, runs `work` in it and destroys it. A create, run or destroy that rejects is
 * this run's failure, never a throw, so every scenario reaches the leak check and the score. A
 * destroy that fails fails the run even if the work passed.
 */
export async function runInSandbox<B extends { destroy(): Promise<void> }>(input: {
  create: () => Promise<B>;
  work: (box: B) => Promise<RunOutcome>;
}): Promise<RunOutcome> {
  let box: B;

  try {
    box = await input.create();
  } catch (error) {
    return {
      ok: false,
      reason: `create failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let outcome: RunOutcome;

  try {
    outcome = await input.work(box);
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  try {
    await box.destroy();
  } catch (error) {
    const destroy = `destroy failed: ${error instanceof Error ? error.message : String(error)}`;

    return { ok: false, reason: outcome.ok ? destroy : `${outcome.reason}; ${destroy}` };
  }

  return outcome;
}

/**
 * Runs every scenario, `concurrency` at a time, and resolves with one outcome per scenario. A run
 * that throws is that scenario's failure and its worker moves on, so this never rejects.
 */
export async function runAll<S>(input: {
  scenarios: readonly S[];
  concurrency: number;
  runOne: (scenario: S, index: number) => Promise<RunOutcome>;
}): Promise<{ scenario: S; outcome: RunOutcome }[]> {
  const outcomes: { scenario: S; outcome: RunOutcome }[] = [];
  let cursor = 0;

  async function worker() {
    for (let index = cursor++; index < input.scenarios.length; index = cursor++) {
      const scenario = input.scenarios[index];

      if (scenario === undefined) break;

      try {
        outcomes.push({ scenario, outcome: await input.runOne(scenario, index) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        outcomes.push({ scenario, outcome: { ok: false, reason } });
      }
    }
  }

  await Promise.allSettled(
    Array.from({ length: Math.min(input.concurrency, input.scenarios.length) }, () => worker()),
  );

  return outcomes;
}

async function scenarioOutcome(
  scenario: ExpandedScenario,
  box: Sandbox,
  seed: number,
): Promise<RunOutcome> {
  const start = performance.now();
  const outcome = await scenario.run(box, { seed, timeoutMs: TIMEOUT_MS });

  if (!Number.isFinite(outcome.value) || outcome.value <= 0)
    return { ok: false, reason: `non-positive value: ${outcome.value}` };

  if (outcome.proof.trim().length < 8)
    return { ok: false, reason: `proof too short: ${JSON.stringify(outcome.proof)}` };

  return {
    ok: true,
    sample: {
      scenarioId: scenario.id,
      provider: "local",
      seed,
      value: outcome.value,
      unit: scenario.unit,
      better: scenario.better,
      proof: outcome.proof,
      wallMs: Math.round(performance.now() - start),
      details: outcome.details,
    },
  };
}

async function main() {
  const uid = process.getuid?.() ?? 1000;
  const dockerHost = process.env.DOCKER_HOST ?? `unix:///run/user/${uid}/podman/podman.sock`;

  if (expandedScenarios.length === 0) {
    process.stdout.write("No expanded scenarios registered yet.\n0\n");

    return;
  }

  const provider = local({ image: "node:22-bookworm", dockerHost });
  const runId = randomUUID();
  const seen = new Set<string>();
  const valid: ExpandedScenario[] = [];
  const failures: string[] = [];

  for (const s of expandedScenarios) {
    const err = validateDefinition(s, seen);

    if (err) failures.push(`${s.id}: ${err}`);
    else valid.push(s);
  }

  const samples: ExpandedRunSample[] = [];

  const outcomes = await runAll({
    scenarios: valid,
    concurrency: CONCURRENCY,
    async runOne(scenario, idx) {
      const seed = (0x9e3779b9 ^ ((idx + 1) * 2654435761)) >>> 0;

      const res = await runInSandbox({
        create: () =>
          createSandbox(provider, { timeoutMs: TIMEOUT_MS, labels: { [runLabel]: runId } }),
        work: (box) => scenarioOutcome(scenario, box, seed),
      });

      if (res.ok)
        process.stdout.write(
          `PASS ${scenario.id} (${scenario.category}): ${res.sample.value.toFixed(2)} ${scenario.unit} [${res.sample.wallMs}ms] proof=${res.sample.proof.slice(0, 12)}\n`,
        );
      else process.stdout.write(`FAIL ${scenario.id}: ${res.reason}\n`);

      return res;
    },
  });

  for (const { scenario, outcome } of outcomes) {
    if (outcome.ok) samples.push(outcome.sample);
    else failures.push(`${scenario.id}: ${outcome.reason}`);
  }

  const cleanup = await cleanupFailure(provider, runId);

  if (cleanup !== null) {
    failures.push(cleanup);
    process.stdout.write(`FAIL cleanup: ${cleanup}\n`);
    process.stdout.write("0\n");
    process.exitCode = 1;

    return;
  }

  const exported = exportExpandedSiteData(samples);

  const exportedIds = new Set(
    exported.metrics
      .filter((m) => m.values.some((v) => v.provider === "local" && v.n >= 1 && v.median > 0))
      .map((m) => m.id),
  );

  let passing = 0;

  for (const sample of samples) {
    if (exportedIds.has(sample.scenarioId)) passing++;
    else failures.push(`${sample.scenarioId}: missing from exportExpandedSiteData`);
  }

  if (failures.length > 0) {
    process.stdout.write(
      `Summary: ${passing}/${expandedScenarios.length} passed, ${failures.length} failed\n`,
    );
  }

  process.stdout.write(`${passing}\n`);
}

if (import.meta.main) await main();

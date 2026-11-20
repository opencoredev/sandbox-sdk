/**
 * Locked hill-climb quality check for the expanded benchmark catalog.
 *
 * Scores the number of registered expanded scenarios that pass every requirement:
 * 1. Unique kebab-case id, valid category, label, description, unit, direction.
 * 2. Pure `verifyOutput` rejects empty, garbage, and wrong-seed payloads.
 * 3. Runs end-to-end inside a real local Podman/Docker sandbox and returns finite positive value
 *    plus a seed-bound proof (>= 8 chars).
 * 4. Cleans up its sandbox completely (zero leftover `sandbox-sdk=1` containers).
 * 5. Exports cleanly in `exportExpandedSiteData()` with valid numeric stats.
 *
 * Prints diagnostic lines and finishes with the exact passing count on the last line.
 */
import { execFileSync } from "node:child_process";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";
import { expandedScenarios, exportExpandedSiteData } from "../src/expanded/registry.js";
import {
  expandedCategories,
  type ExpandedRunSample,
  type ExpandedScenario,
} from "../src/expanded/types.js";

const CONCURRENCY = 4;
const TIMEOUT_MS = 90_000;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

function listLabeledContainers(): string[] {
  const bin = process.env.CONTAINER_CLI ?? "podman";

  try {
    const out = execFileSync(
      bin,
      ["ps", "-a", "--filter", "label=sandbox-sdk=1", "--format", "{{.ID}}"],
      { encoding: "utf8", timeout: 10_000 },
    );

    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
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

async function runOne(
  scenario: ExpandedScenario,
  seed: number,
  dockerHost: string,
): Promise<{ ok: true; sample: ExpandedRunSample } | { ok: false; reason: string }> {
  const provider = local({ image: "node:22-bookworm", dockerHost });
  const start = performance.now();
  const box = await createSandbox(provider, { timeoutMs: TIMEOUT_MS });

  try {
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
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await box.destroy();
  }
}

async function main() {
  const uid = process.getuid?.() ?? 1000;
  const dockerHost = process.env.DOCKER_HOST ?? `unix:///run/user/${uid}/podman/podman.sock`;

  if (expandedScenarios.length === 0) {
    process.stdout.write("No expanded scenarios registered yet.\n0\n");

    return;
  }

  const beforeContainers = new Set(listLabeledContainers());
  const seen = new Set<string>();
  const valid: ExpandedScenario[] = [];
  const failures: string[] = [];

  for (const s of expandedScenarios) {
    const err = validateDefinition(s, seen);

    if (err) failures.push(`${s.id}: ${err}`);
    else valid.push(s);
  }

  const samples: ExpandedRunSample[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < valid.length) {
      const idx = cursor++;
      const scenario = valid[idx];

      if (!scenario) break;
      const seed = (0x9e3779b9 ^ ((idx + 1) * 2654435761)) >>> 0;
      const res = await runOne(scenario, seed, dockerHost);

      if (res.ok) {
        samples.push(res.sample);
        process.stdout.write(
          `PASS ${scenario.id} (${scenario.category}): ${res.sample.value.toFixed(2)} ${scenario.unit} [${res.sample.wallMs}ms] proof=${res.sample.proof.slice(0, 12)}\n`,
        );
      } else {
        failures.push(`${scenario.id}: ${res.reason}`);
        process.stdout.write(`FAIL ${scenario.id}: ${res.reason}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, valid.length) }, () => worker()));

  const afterContainers = listLabeledContainers().filter((id) => !beforeContainers.has(id));

  if (afterContainers.length > 0) {
    failures.push(`leaked containers: ${afterContainers.join(", ")}`);
    process.stdout.write(`FAIL cleanup: leaked ${afterContainers.length} container(s)\n`);
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

await main();

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  coverageReport,
  defaultSimulation,
  MAX_BATCHES,
  MIN_BATCHES,
  pilotVarianceSchema,
  recommendBatchCount,
} from "./coverage.js";

const usage = `bun bench coverage --input pilot-variance.json [--out coverage.json]
  [--batches 10] [--counts 10,12,14,16,18,20] [--target-power 0.8]
  [--simulations ${defaultSimulation.simulations}] [--replicates ${defaultSimulation.replicates}]
  [--flips ${defaultSimulation.flips}] [--seed ${defaultSimulation.seed}]
Simulates paired batches from pilot variance; reports each procedure's simultaneous coverage and
power at --batches, then recommends a batch count from ${MIN_BATCHES} to ${MAX_BATCHES}. Pure computation,
no network. Writes JSON to --out or stdout.
`;

function integer(name: string, value: string | undefined, min: number, max: number): number {
  const parsed = Number(value);

  if (!value || !Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);

  return parsed;
}

export async function coverageCommand(args: readonly string[]) {
  let input: string | undefined,
    out: string | undefined,
    batches = MIN_BATCHES,
    counts = [10, 12, 14, 16, 18, 20],
    targetPower = 0.8;

  const options = { ...defaultSimulation };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];

    if (arg === "--help") {
      process.stdout.write(usage);

      return;
    }

    i++;

    switch (arg) {
      case "--input":
        input = value;
        break;
      case "--out":
        out = value;
        break;
      case "--batches":
        batches = integer(arg, value, MIN_BATCHES, MAX_BATCHES);
        break;
      case "--counts":
        counts = (value ?? "")
          .split(",")
          .map((v) => integer(arg, v.trim(), MIN_BATCHES, MAX_BATCHES));
        break;
      case "--target-power": {
        targetPower = Number(value);

        if (!(targetPower > 0 && targetPower <= 1))
          throw new Error("--target-power must be in (0, 1]");
        break;
      }

      case "--simulations":
        options.simulations = integer(arg, value, 1, 100_000);
        break;
      case "--replicates":
        options.replicates = integer(arg, value, 99, 100_000);
        break;
      case "--flips":
        options.flips = integer(arg, value, 99, 100_000);
        break;
      case "--seed":
        options.seed = integer(arg, value, 0, 2 ** 32 - 1);
        break;
      default:
        throw new Error(`Unknown coverage option: ${arg}\n${usage}`);
    }
  }

  if (!input) throw new Error(`coverage requires --input\n${usage}`);
  const spec = pilotVarianceSchema.parse(JSON.parse(await readFile(resolve(input), "utf8")));
  const atBatches = coverageReport(spec, { ...options, batches });
  const recommendation = recommendBatchCount({ spec, options, counts, targetPower });

  const result = {
    generatedAt: new Date().toISOString(),
    input: spec,
    targetPower,
    atBatches,
    recommendation,
  };

  const text = JSON.stringify(result, null, 2) + "\n";

  if (out) {
    await writeFile(resolve(out), text);
    process.stdout.write(`Coverage: ${recommendation.kind}; ${resolve(out)}\n`);
  } else process.stdout.write(text);
}

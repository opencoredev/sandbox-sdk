/**
 * `bun bench realistic burst`: "Real tasks at once" (burst.ts) on real providers.
 *
 * Each provider gets `--rounds` rounds of `--size` Fix and test tasks started together on the
 * same-machine track, with the setup the headline runs use (setup.ts, loadSlotProvider). Providers
 * run `--parallel` at a time; two on one account never overlap. Output in `--out`:
 *
 *   run.json         the run's identity (commit, times, location, size, rounds)
 *   attempts.jsonl   one attempt record per task, as the headline writes them (variant "concurrent")
 *   rounds.jsonl     per round: release and all-done times, listings before and after, leftovers;
 *                    and one line per provider not run, with the reason
 *   notes.jsonl      sandboxes as they are created, budget and sweep notes
 *   realtask-burst.json, summary.md   the site data file and a table (also `burst-summary`)
 *
 * Timing only: no billing windows and no costs. Spend is estimated at list price to keep the run
 * under `--budget-usd`.
 */
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { sanitize } from "../v2-runner.js";
import {
  accountRefusal,
  isAccountLimit,
  runPool,
  runRound,
  spendGuard,
  summarizeProvider,
  type ProviderBurst,
  type RoundReport,
} from "./burst.js";
import {
  artifactPaths,
  attemptBudget,
  defaultArtifactDirs,
  defaultManifest,
  loadSlotProvider,
  regionsFile,
  sweepProviders,
  type RunNote,
} from "./cli.js";
import { harnessManifestFromFrozen } from "./frozen.js";
import { systemClock } from "./gaps.js";
import { fileArtifacts } from "./prepare.js";
import { attemptRecordSchema, type AttemptRecord } from "./record.js";
import { providerRegion } from "../providers.js";
import { providerSetup, provisionedFor, provisionedOf, type ProviderSetup } from "./setup.js";
import type { SlotProvider } from "./slots.js";
import { sha256Hex } from "./steps.js";

const defaultSolo =
  "/home/leo/.t3/worktrees/sandbox-bench/15c0f164-c252cad79f79cc43/src/data/realistic.json";

const allProviders = [
  "boat",
  "boxd",
  "daytona",
  "e2b",
  "freestyle",
  "superserve",
  "tenki",
  "upstash",
  "upstash-ephemeral",
  "vercel",
  "modal",
  "baseten",
  "instabox",
  "beam",
];

const listingSchema = z.object({
  at: z.number(),
  ids: z.array(z.string()).readonly().nullable(),
  runIds: z.array(z.string()).readonly().nullable(),
  error: z.string().nullable(),
});

const roundLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("round"),
    provider: z.string(),
    round: z.number().int(),
    size: z.number().int(),
    startedAt: z.number(),
    allDoneAt: z.number(),
    before: listingSchema,
    after: listingSchema,
    ownBefore: z.array(z.string()).readonly(),
    leftovers: z
      .array(z.object({ id: z.string(), destroyed: z.boolean(), goneAfter: z.boolean() }))
      .readonly(),
    attemptIds: z.array(z.string()),
  }),
  z.object({ kind: z.literal("not-run"), provider: z.string(), reason: z.string() }),
]);

type RoundLine = z.infer<typeof roundLineSchema>;

const runInfoSchema = z.object({
  id: z.string(),
  sdkCommit: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  location: z.string(),
  size: z.number().int(),
  rounds: z.number().int(),
  track: z.literal("same-machine"),
  profile: z.literal("fix-and-test"),
  providers: z.array(z.string()),
  budgetUSD: z.number(),
});

type RunInfo = z.infer<typeof runInfoSchema>;

/** The site's realistic data file: only the fields read here. */
const soloFileSchema = z.object({
  rows: z.array(
    z.looseObject({
      provider: z.string(),
      profile: z.string(),
      track: z.string(),
      variant: z.string(),
      medianWallS: z.number().nullable(),
    }),
  ),
});

/** Each provider's published solo median for same-machine Fix and test. */
export async function soloMedians(path: string): Promise<Map<string, number | null>> {
  const file = soloFileSchema.parse(JSON.parse(await readFile(path, "utf8")));

  return new Map(
    file.rows
      .filter(
        (r) =>
          r.variant === "headline" && r.track === "same-machine" && r.profile === "fix-and-test",
      )
      .map((r) => [r.provider, r.medianWallS]),
  );
}

async function readLines<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }

  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => schema.parse(JSON.parse(line)));
}

const positiveInt = (name: string, value: string) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`--${name} must be a positive integer, got ${value}`);

  return parsed;
};

/** List-price estimate of what a finished task cost (EUR counted at 2x, as the headline guard). */
function taskSpend(setup: ProviderSetup, record: AttemptRecord) {
  if (record.sandboxIds.length === 0) return 0;

  const size =
    provisionedOf(setup, "same-machine", record) ??
    provisionedFor(setup, "same-machine", record.profile);

  return attemptBudget(setup, "same-machine", record.endedAt - record.startedAt, size);
}

function sdkCommit(): string {
  const pinned = process.env.BENCH_COLLECTION_COMMIT?.trim();

  if (pinned) return pinned;

  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export async function burstCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: "string", default: defaultManifest },
      out: { type: "string" },
      run: { type: "string" },
      providers: { type: "string" },
      tracks: { type: "string", default: "same-machine" },
      profile: { type: "string", default: "fix-and-test" },
      size: { type: "string", default: "5" },
      rounds: { type: "string", default: "2" },
      parallel: { type: "string", default: "3" },
      "budget-usd": { type: "string", default: "15" },
      solo: { type: "string", default: defaultSolo },
      location: { type: "string", default: "Boca Raton, FL (evo-1)" },
      "artifact-dir": { type: "string", multiple: true },
    },
  });

  if (!values.out || !values.run) throw new Error("realistic burst needs --out and --run");

  // The published comparison is same-machine Fix and test; nothing else is supported.
  if (values.tracks !== "same-machine")
    throw new Error("realistic burst runs the same-machine track only");

  if (values.profile !== "fix-and-test")
    throw new Error("realistic burst runs the fix-and-test profile only");
  const track = "same-machine" as const;
  const profileName = "fix-and-test" as const;
  const size = positiveInt("size", values.size);
  const rounds = positiveInt("rounds", values.rounds);
  const parallel = positiveInt("parallel", values.parallel);
  const guard = spendGuard(Number(values["budget-usd"]));
  const runId = values.run;
  const out = resolve(values.out);
  await mkdir(join(out, "outputs"), { recursive: true });
  const attemptsPath = join(out, "attempts.jsonl");
  const roundsPath = join(out, "rounds.jsonl");
  const notesPath = join(out, "notes.jsonl");

  const note = (entry: RunNote) =>
    appendFile(notesPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");

  const writeRound = (line: RoundLine) =>
    appendFile(roundsPath, JSON.stringify(roundLineSchema.parse(line)) + "\n");

  const say = (text: string) =>
    process.stdout.write(`[${new Date().toISOString()}] ${sanitize(text)}\n`);

  const names = values.providers
    ? values.providers
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : allProviders;

  const setups = names.map(providerSetup);
  const solo = await soloMedians(values.solo);

  const info: RunInfo = {
    id: runId,
    sdkCommit: sdkCommit(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    location: values.location,
    size,
    rounds,
    track,
    profile: profileName,
    providers: names,
    budgetUSD: guard.state().capUSD,
  };

  await writeFile(join(out, "run.json"), JSON.stringify(info, null, 2) + "\n");

  const regions: Record<string, string | null> = {};

  for (const setup of setups) regions[setup.adapter] = providerRegion(setup.adapter, process.env);
  await writeFile(join(out, regionsFile), JSON.stringify(regions, null, 2) + "\n");

  const frozenJson = await readFile(values.manifest, "utf8");
  const manifest = harnessManifestFromFrozen(frozenJson);
  const manifestSha256 = sha256Hex(frozenJson);
  const profile = manifest.profiles[profileName];

  if (!profile) throw new Error(`The manifest has no ${profileName} profile`);
  const slotMs = profile.slotTimeoutMs;

  const { wanted, found } = await artifactPaths(
    manifest,
    values["artifact-dir"] ?? defaultArtifactDirs,
  );

  const missing = [...wanted].flatMap(([sha, name]) => (found.has(sha) ? [] : [name]));

  if (missing.length) await note({ kind: "missing-artifacts", files: missing });
  const source = fileArtifacts(found);
  const blobs = { get: (sha: string) => source.read(sha) };

  const notRun = async (provider: string, reason: string) => {
    await writeRound({ kind: "not-run", provider, reason: sanitize(reason) });
    say(`${provider}: not run: ${reason}`);
  };

  const loaded: { setup: ProviderSetup; entry: SlotProvider }[] = [];

  for (const setup of setups) {
    const config = setup.tracks[track];
    const refusal = accountRefusal({ provider: setup.name, size, vcpu: config.vcpu });

    if (refusal) {
      await notRun(setup.name, refusal);
      continue;
    }

    const tooSmall = config.tooSmall[profileName];

    if (tooSmall) {
      await notRun(setup.name, tooSmall);
      continue;
    }

    // Fix and test has no profile factory (only Baseten's build does), so the plain adapter runs it.
    const result = await loadSlotProvider(setup, track, slotMs, join(out, "usage"), out);

    if (result.kind === "skipped") await notRun(setup.name, `adapter not loaded: ${result.note}`);
    else loaded.push({ setup, entry: result.entry });
  }

  try {
    await runPool({
      items: loaded,
      parallel,
      account: ({ setup }) => setup.adapter,
      run: async ({ setup, entry }) => {
        const created = new Set<string>();
        let ranAny = false;

        for (let round = 1; round <= rounds; round++) {
          const reserve =
            size * attemptBudget(setup, track, slotMs, provisionedFor(setup, track, profileName));

          // Other providers' rounds in flight may hold the reservation: wait for them to settle.
          let reserved = guard.reserve(reserve);

          while (!reserved && guard.couldFit(reserve)) {
            await systemClock.sleep(5_000);
            reserved = guard.reserve(reserve);
          }

          if (!reserved) {
            const state = guard.state();
            await note({ kind: "budget-stop", provider: setup.name, round, ...state, reserve });

            if (!ranAny)
              await notRun(
                setup.name,
                `spend ceiling: $${state.spentUSD.toFixed(2)} spent and $${state.reservedUSD.toFixed(2)} reserved, a round reserves $${reserve.toFixed(2)}, ceiling $${state.capUSD}`,
              );
            else say(`${setup.name}: round ${round} skipped at the spend ceiling`);

            return;
          }

          say(`${setup.name}: round ${round}, ${size} tasks`);
          let report: RoundReport;

          try {
            report = await runRound({
              runId,
              round,
              size,
              manifest,
              manifestSha256,
              profileName,
              track,
              entry,
              clock: systemClock,
              blobs,
              prepare: { cacheBaseUrl: "sdk-upload", upload: { source } },
              outputDir: join(out, "outputs"),
              created,
              onRecord: (record) => appendFile(attemptsPath, JSON.stringify(record) + "\n"),
              onSandbox: (id) => note({ kind: "sandbox", provider: setup.name, id, round }),
            });
          } catch (error) {
            guard.settle({ reservedUSD: reserve, spentUSD: 0 });
            await note({
              kind: "round-error",
              provider: setup.name,
              round,
              error: sanitize(error instanceof Error ? error.message : String(error)),
            });
            say(`${setup.name}: round ${round} failed before its tasks finished; see notes`);

            return;
          }

          ranAny = true;
          const spent = report.records.reduce((sum, r) => sum + taskSpend(setup, r), 0);
          guard.settle({ reservedUSD: reserve, spentUSD: spent });

          await writeRound({
            kind: "round",
            provider: setup.name,
            round,
            size,
            startedAt: report.startedAt,
            allDoneAt: report.allDoneAt,
            before: report.before,
            after: report.after,
            ownBefore: report.ownBefore,
            leftovers: report.leftovers,
            attemptIds: report.records.map((r) => r.attemptId),
          });

          for (const record of report.records)
            say(
              `  ${setup.name} ${record.slot.id}: ${record.completion.kind === "completed" ? "completed" : `${record.completion.reason}: ${record.completion.detail.slice(0, 160)}`} (${Math.round((record.endedAt - record.startedAt) / 1000)} s)`,
            );
          say(
            `${setup.name}: round ${round} all done in ${Math.round((report.allDoneAt - report.startedAt) / 1000)} s; leftovers ${report.leftovers.length}; est. spent $${guard.state().spentUSD.toFixed(2)}`,
          );

          // Every create refused by an account limit: another round would be refused too.
          if (report.records.every(isAccountLimit)) {
            say(`${setup.name}: every create was refused by an account limit; no more rounds`);

            return;
          }
        }
      },
    });
  } finally {
    // Always: nothing this run made is left running, whatever stopped it.
    const swept = await sweepProviders(
      runId,
      loaded.map((l) => l.entry),
      note,
      out,
    );

    await note({ kind: "sweep-result", ...swept });

    if (swept.failed || swept.undeleted || swept.unchecked) {
      process.stderr.write(`Sweep left something; see ${notesPath}\n`);
      process.exitCode = 1;
    }

    await writeFile(
      join(out, "run.json"),
      JSON.stringify({ ...info, endedAt: new Date().toISOString() }, null, 2) + "\n",
    );
    await note({ kind: "spend", ...guard.state() });
  }

  const data = await buildExport([out], solo);
  await writeFile(join(out, "realtask-burst.json"), JSON.stringify(data, null, 2) + "\n");
  await writeFile(join(out, "summary.md"), summaryMarkdown(data, guard.state().spentUSD));
  process.stdout.write(summaryMarkdown(data, guard.state().spentUSD));
}

export interface BurstExport {
  readonly schema: 1;
  readonly generatedAt: string;
  readonly run: {
    readonly id: string;
    readonly sdkCommit: string;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly location: string;
  };
  readonly size: number;
  readonly rounds: number;
  readonly track: "same-machine";
  readonly profile: "fix-and-test";
  readonly providers: readonly ProviderBurst[];
}

/**
 * The site data file from one or more run folders. A provider in a later folder replaces the same
 * provider from an earlier one (a rerun), and every folder must share the run's size and rounds.
 */
export async function buildExport(
  dirs: readonly string[],
  solo: ReadonlyMap<string, number | null>,
): Promise<BurstExport> {
  const byProvider = new Map<
    string,
    { info: RunInfo; lines: RoundLine[]; records: AttemptRecord[] }
  >();

  let first: RunInfo | null = null;

  for (const dir of dirs) {
    const info = runInfoSchema.parse(JSON.parse(await readFile(join(dir, "run.json"), "utf8")));

    if (first && (first.size !== info.size || first.rounds !== info.rounds))
      throw new Error(
        `${dir} ran ${info.size} x ${info.rounds}, not ${first.size} x ${first.rounds}`,
      );
    first ??= info;
    const lines = await readLines(join(dir, "rounds.jsonl"), roundLineSchema);
    const records = await readLines(join(dir, "attempts.jsonl"), attemptRecordSchema);

    for (const provider of new Set(lines.map((l) => l.provider)))
      byProvider.set(provider, {
        info,
        lines: lines.filter((l) => l.provider === provider),
        records: records.filter((r) => r.provider === provider && r.runId === info.id),
      });
  }

  if (!first) throw new Error("burst-summary needs at least one --out");

  const order = [
    ...first.providers,
    ...[...byProvider.keys()].filter((p) => !first.providers.includes(p)),
  ];

  const providers = order.flatMap((provider): ProviderBurst[] => {
    const found = byProvider.get(provider);

    if (!found) return [];
    const skipped = found.lines.find((l) => l.kind === "not-run");
    const rounds = found.lines.flatMap((l) => (l.kind === "round" ? [l] : []));

    return [
      summarizeProvider({
        provider,
        records: found.records,
        rounds,
        soloMedianWallS: solo.get(provider) ?? null,
        notRun: skipped?.kind === "not-run" && rounds.length === 0 ? skipped.reason : undefined,
        redact: sanitize,
      }),
    ];
  });

  const runs = [...new Set([...byProvider.values()].map((v) => v.info))];
  const startedAt = runs.map((r) => r.startedAt).sort()[0] ?? first.startedAt;
  const ends = runs.map((r) => r.endedAt);

  const endedAt = ends.includes(null)
    ? null
    : (ends
        .filter((e) => e !== null)
        .sort()
        .at(-1) ?? null);

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    run: {
      id: [...new Set(runs.map((r) => r.id))].join("+"),
      sdkCommit: [...new Set(runs.map((r) => r.sdkCommit))].join("+"),
      startedAt,
      endedAt,
      location: first.location,
    },
    size: first.size,
    rounds: first.rounds,
    track: "same-machine",
    profile: "fix-and-test",
    providers,
  };
}

export function summaryMarkdown(data: BurstExport, spentUSD: number | null): string {
  const s = (v: number | null) => (v === null ? "n/a" : v.toFixed(1));

  const lines = data.providers.map((p) => {
    const failures = p.tasks.flatMap((t) =>
      t.failure ? [`r${t.round} ${t.failure.stage}: ${t.failure.reason.slice(0, 120)}`] : [],
    );

    return `| ${p.provider} | ${p.status === "ran" ? "ran" : `not run: ${p.reason}`} | ${s(p.medianWallS)} | ${s(p.soloMedianWallS)} | ${p.slowdown === null ? "n/a" : `${p.slowdown.toFixed(2)}x`} | ${p.completed}/${p.attempts} | ${p.roundAllDoneS.map((v) => v.toFixed(0)).join(", ") || "n/a"} | ${failures.join("; ").replaceAll("|", "/") || "none"} |`;
  });

  return [
    `Real tasks at once: ${data.size} Fix and test tasks started together per round, ${data.rounds} rounds, same-machine track. Run ${data.run.id} at ${data.run.sdkCommit.slice(0, 7)} from ${data.run.location}.`,
    "Timing only: billing windows were not reconciled and no cost is claimed.",
    spentUSD === null ? "" : `Estimated spend at list price: $${spentUSD.toFixed(2)}.`,
    "",
    "| Provider | Status | Median wall (s) | Solo median (s) | Slowdown | Completed | All done per round (s) | Failures |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...lines,
    "",
  ].join("\n");
}

export async function burstSummaryCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string", multiple: true },
      solo: { type: "string", default: defaultSolo },
      to: { type: "string" },
    },
  });

  if (!values.out?.length || !values.to) throw new Error("burst-summary needs --out and --to");

  const data = await buildExport(
    values.out.map((d) => resolve(d)),
    await soloMedians(values.solo),
  );

  await writeFile(resolve(values.to), JSON.stringify(data, null, 2) + "\n");
  process.stdout.write(summaryMarkdown(data, null));
}

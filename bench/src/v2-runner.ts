import { createSandbox, connectSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import type { CreateInput } from "@opencoredev/sandbox-sdk/provider";
import { cpus, loadavg } from "node:os";
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import type { ConfigV2 } from "./v2-config.js";
import type { LoadedProvider, ReadyProvider } from "./providers.js";
import type { ReportV2, Sample, HostSample, Outcome } from "./v2-model.js";
import { PhaseClock, perfMetrics, filePayloads, firstByteAttempt } from "./measurement.js";
import { collectMetadata, headroom } from "./publication.js";
import { resources, parseFingerprint, type Fingerprint } from "./fingerprint.js";
import { estimateCost, budgetUSD, pricing } from "./pricing.js";
import { roundRobin, schedule } from "./scheduler.js";
import { shuffle, distribution, wilson } from "./v2-stats.js";
import { deadline, PendingWork } from "./timing.js";
import { command, Skip, uploadFixture, cloneCommand, previewText, replay } from "./workloads.js";
import { snapshotCleaner, createNamedDaytonaSnapshot, snapshotsFromDaytonaSandbox } from "./snapshots.js";
export const scenarioNames = [
  "command",
  "files-1kb",
  "files-10mb",
  "reconnect",
  "pause-resume",
  "snapshot",
  "fingerprint",
  "perf",
  "git-clone",
  "npm-install",
  "dev-server",
  "preview-first-byte",
  "edit-loop",
  "tool-replay",
  "pip-install",
];
const workloadNames = new Set([
  "git-clone",
  "npm-install",
  "dev-server",
  "preview-first-byte",
  "edit-loop",
  "tool-replay",
  "pip-install",
]);
const perfSchema = z.object({
  metrics: z.record(z.string(), z.number().finite()),
  notes: z.array(z.string()),
  workers: z.number(),
  method: z.string(),
});
const errorNote = (error: unknown) =>
  sanitize(error instanceof Error ? error.message : "Unknown failure");
export function sanitize(text: string) {
  let result = text;
  for (const [name, value] of Object.entries(process.env))
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(name) && value && value.length > 5)
      result = result.replaceAll(value, "[REDACTED]");
  return result;
}
async function host(): Promise<HostSample> {
  return {
    timestamp: new Date().toISOString(),
    load: loadavg(),
    cpu: process.cpuUsage(),
    cpuTicks: cpus().map((c) => Object.values(c.times)),
    network: await readFile("/proc/net/dev", "utf8").catch(() => "unavailable"),
  };
}
export function summarize(samples: Sample[], seed: number) {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = `${s.provider}/${s.scenario}/${s.unit}`;
    const values = groups.get(key) ?? [];
    values.push(s);
    groups.set(key, values);
  }
  return [...groups.values()].flatMap((rows) => {
    const first = rows[0];
    if (!first) return [];
    const successes = rows.filter((r) => r.outcome.kind === "sample"),
      values = successes.flatMap((r) => (r.outcome.kind === "sample" ? [r.outcome.value] : [])),
      failures = rows.filter((r) => r.outcome.kind === "failure").length;
    const costs = rows.map((r) => r.estimatedCost),
      cost = costs.every((c) => c !== null) ? costs.reduce((a, b) => a + b, 0) : null;
    const efficiency = successes.map((row) => {
      const rate = estimateCost(
        row.provider,
        1000,
        row.fingerprint ? resources(row.fingerprint) : (pricing[row.provider]?.fixed ?? null),
      );
      if (!rate || row.outcome.kind !== "sample" || row.outcome.value <= 0) return null;
      return (row.unit === "ms" ? 1000 / row.outcome.value : row.outcome.value) / rate;
    });
    const performancePerDollar =
      efficiency.length && efficiency.every((v) => v !== null)
        ? efficiency.reduce((a, b) => a + b, 0) / efficiency.length
        : null;
    return [
      {
        provider: first.provider,
        scenario: first.scenario,
        unit: first.unit,
        stats: distribution(values, seed),
        success: wilson(successes.length, successes.length + failures),
        failures,
        skipped: rows.filter((r) => r.outcome.kind === "skipped").length,
        blocked: rows.filter((r) => r.outcome.kind === "blocked").length,
        estimatedCost: cost,
        per1000: cost === null ? null : (cost / rows.length) * 1000,
        performancePerDollar,
      },
    ];
  });
}
export async function runV2(
  loaded: LoadedProvider[],
  config: ConfigV2,
  checkpoint: (report: ReportV2) => Promise<void>,
  metadata = collectMetadata(),
) {
  await mkdir(resolve(config.out), { recursive: true });
  await writeFile(join(resolve(config.out), "run.json"), JSON.stringify({ runId: config.run }), { flag: "wx" });
  const report: ReportV2 = {
    schemaVersion: 2,
    runId: config.run,
    timestamp: new Date().toISOString(),
    finishedAt: "",
    config,
    metadata: await metadata,
    host: { cpu: cpus()[0]?.model ?? "unknown", os: process.platform, runtime: process.version },
    samples: [],
    summaries: [],
    providers: loaded.map((p) => ({
      name: p.name,
      kind: p.kind,
      configuredRegion: p.kind === "ready" ? p.region : null,
      note:
        p.kind === "skipped"
          ? p.note
          : p.name === "local"
            ? "Docker reference baseline; host costs excluded"
            : "Provider default image and allocation",
    })),
    cleanup: [],
    budgets: {},
    methodology: [
      "Daytona snapshots use its native nameable API to journal a run-owned snapshot name before creation; the SDK wrapper generates a name internally and loses it on timeout. Other lifecycle calls use the common SDK. Snapshot timeout is retained as failure and cleanup uses only journaled names.",
      "Round-robin iteration admission, independent per-provider and global limits. Seeded scenario groups; dependencies (install → dev → preview → edit) retain order. Fingerprint first, cold first, destroy last. No warmup samples discarded.",
      "Cold/reconnect/resume/restore use client monotonic clock through a successful true command. API-return and readiness phase timestamps are recorded separately. Create API phase includes provider-native readiness but excludes SDK handle initialization.",
      "Default-size comparison: each provider uses its default image/allocation; local uses medium. This is not a resource-matched hardware comparison. Image, package, CDN and filesystem caches are uncontrolled; installed runtime versions are retained.",
      "Dependent scenarios share a sandbox. A failed cold/reconnect/resume/snapshot blocks subsequent work; blocked_by rows are reported separately and excluded from independent failure denominators. App install/provision/start/preview prerequisites also propagate blocking. Cleanup still runs.",
      "Preview provisioning and dev-server start are separate scenarios. Each HTTP attempt is timed through its first chunk only; cancellation and inter-attempt sleeps are outside that measurement. Failed attempts remain failure rows. Snapshot values time native API only; snapshot-setup and snapshot-total expose client setup/journal overhead.",
      "Repeated burst cohorts retain independent cohort indices. Client-headroom flags use load1/logical CPUs >=1 or sampled host CPU utilization >=90%; overlapping samples share host counters and must not be summed as provider-attributable traffic.",
      "At n=100, nearest-rank p99 depends on roughly the two slowest observations and is unstable. Bootstrap intervals do not eliminate this tail uncertainty; publish sample counts and raw values.",
      "All failures retained; percentiles/CI describe successful observations only. Independent success rate uses Wilson 95% interval (skips and blocked dependencies excluded). Nearest rank, population stddev, 2000 seeded bootstrap resamples for p50 and mean. No outlier removal.",
      "Fingerprint includes public ipinfo.io lookup (optional); region and org are observed egress, not a promise about placement. Host counters are cumulative: difference before/after to derive CPU and network load.",
      "CPython fixed LCG iterations/s; all-core uses ceil of min(nproc, cgroup quota), capped at 64 with worker count recorded. Python version and CPU flags retained: runtime differences remain a confounder. 16 MiB memory copy; 64 MiB buffered sequential I/O; fsync writes and 256 random 4 KiB operations at queue depth 1. Reads may be cached; no O_DIRECT. Decimal MB/s.",
      "Network: 25,000,000 bytes from speed.cloudflare.com including TLS; mean of five TCP connects to 1.1.1.1:443. Egress geography, CDN caches, shared host load and provider caches are uncontrolled.",
      "Costs are estimates, not invoices; marginal usage only, excludes subscriptions/credits/transfer/persistent snapshot retention. Cost per scenario allocates its measured duration; sandbox-lifetime records include setup and idle time and must not be summed with scenario allocations. Upstash/boxd allocated-resource estimates are upper bounds. Unknown resources yield null, never zero. Pricing retrieval dates are recorded per provider; EUR and USD remain separate with no cross-currency ranking.",
      "Budget admission reserves timeout × scenario count at observed or conservative default resources. Dollar budgets are estimates, not account spend caps; boxd uses conservative 2 USD/EUR for budget only. Failed/unknown creations count toward sandbox budget.",
    ],
  };
  let reportWrites = Promise.resolve();
  const save = () => {
    reportWrites = reportWrites.then(() => checkpoint(report));
    return reportWrites;
  };
  const stopping = new AbortController();
  const requestStop = () => {
    stopping.abort();
  };
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  const ready = loaded.filter((p) => p.kind === "ready");
  type ProviderState = {
    created: number;
    estimatedUSD: number;
    stop: string | null;
    reserved: number;
    fp: Fingerprint | null;
  };
  const states = new Map<string, ProviderState>(
    ready.map((p) => [
      p.name,
      {
        created: 0,
        estimatedUSD: 0,
        stop: null,
        reserved: 0,
        fp: null,
      },
    ]),
  );
  const runDir = resolve(config.out);
  await mkdir(runDir, { recursive: true });
  // Serialized durable ownership journal permits cleanup even if list metadata is unavailable.
  const unsafeProviders = new Set<string>();
  const owned = new Map<
    string,
    { provider: string; id: string; kind: "sandbox" | "snapshot" | "snapshot-source"; parent: string | null }
  >();
  let journal = Promise.resolve();
  function persist() {
    const data = JSON.stringify({ runId: config.run, resources: [...owned.values()] }, null, 2);
    journal = journal.then(() => writeFile(join(runDir, "ownership.json"), data));
    return journal;
  }
  async function remove(loaded: ReadyProvider, id: string) {
    for (let attempt = 0; attempt < 3; attempt++)
      try {
        await deadline(config["timeout-ms"], () => loaded.provider.destroy(id));
        owned.delete(`${loaded.name}/${id}`);
        await persist();
        return;
      } catch (e) {
        if (attempt === 2) throw e;
      }
  }
  function selected(scenario: string) {
    return config.scenarios.includes("all") || config.scenarios.includes(scenario);
  }
  async function iteration(
    p: ReadyProvider,
    index: number,
    burst = 0,
    barrier?: () => Promise<void>,
  ) {
    const foundState = states.get(p.name);
    if (!foundState) return;
    const state = foundState;
    const timeout = config["timeout-ms"];
    let fp: Fingerprint | null = null;
    let box: Sandbox | undefined;
    const pending = new PendingWork();
    const ids = new Set<string>();
    let unsafe = false;
    let blockedBy: string | null = null;
    const dependencies = new Map<string, string>();
    const reconnectedHandles: Sandbox[] = [];
    let restoredDurationMs = 0;
    let restoredCost: number | null = 0;
    const lifeStart = performance.now();
    let reserve = 0;
    const hostStart = await host();
    const startTime = new Date().toISOString();
    const phases: Record<string, number> = {};
    const budgetMax = config["provider-max-sandboxes"][p.name] ?? config["max-sandboxes"];
    const dollarsMax = config["provider-max-dollars"][p.name] ?? config["max-dollars"];
    reserve = budgetUSD(
      p.name,
      estimateCost(
        p.name,
        timeout * (burst ? 2 : scenarioNames.length + 4),
        state.fp ? resources(state.fp) : { cpu: 8, memoryGiB: 16, diskGiB: 100 },
      ) ?? dollarsMax,
    );
    const stop =
      state.stop ??
      (stopping.signal.aborted ? "Interrupted; no more sandboxes scheduled" : null) ??
      (state.created >= budgetMax
        ? "Sandbox budget reached"
        : state.estimatedUSD + state.reserved + reserve > dollarsMax
          ? "Estimated dollar budget reached"
          : null);
    if (stop) {
      state.stop = stop;
      report.budgets[p.name] = { created: state.created, estimatedUSD: state.estimatedUSD, stop };
      await barrier?.();
      return;
    }
    state.created++;
    state.reserved += reserve;
    const tracked = new Proxy(p.provider, {
      get(target, key) {
        if (key === "create")
          return (input: CreateInput) =>
            pending.track(
              (async () => {
                if (input.from) {
                  if (state.created >= budgetMax) throw new Skip("Sandbox budget prevents restore");
                  state.created++;
                }
                const start = performance.now();
                const info = await target.create(input);
                phases.apiReturnedMs = performance.now() - start;
                ids.add(info.id);
                owned.set(`${p.name}/${info.id}`, {
                  provider: p.name,
                  id: info.id,
                  kind: "sandbox",
                  parent: null,
                });
                await persist();
                if (input.signal?.aborted) {
                  await remove(p, info.id);
                  ids.delete(info.id);
                  throw new Error("Late create cleaned up");
                }
                return info;
              })(),
            );
        if (key === "destroy")
          return (id: string) =>
            pending.track(
              remove(p, id).then(() => {
                ids.delete(id);
              }),
            );
        const member: unknown = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    const add = async (
      scenario: string,
      unit: string,
      outcome: Outcome,
      start: number,
      startedAt: string,
      before: HostSample,
      details: unknown = null,
      phaseValues: Record<string, number> = {},
      clock?: PhaseClock,
      observedAfter?: HostSample,
    ) => {
      const durationMs = clock?.elapsed() ?? performance.now() - start;
      const hostAfter = observedAfter ?? await host();
      const sample: Sample = {
        provider: p.name,
        iteration: index,
        scenario: burst ? `burst-${burst}/${scenario}` : scenario,
        unit,
        startedAt: clock?.startedAt ?? startedAt,
        finishedAt: clock?.finishedAt ?? new Date().toISOString(),
        durationMs,
        sandboxId: box?.id ?? [...ids][0] ?? null,
        outcome,
        phases: { ...phaseValues },
        hostBefore: before,
        hostAfter,
        headroom: headroom(before, hostAfter),
        fingerprint: fp,
        estimatedCost: estimateCost(
          p.name,
          durationMs,
          fp ? resources(fp) : (pricing[p.name]?.fixed ?? null),
        ),
        details,
      };
      report.samples.push(sample);
      await appendFile(join(runDir, "samples.ndjson"), JSON.stringify(sample) + "\n");
      process.stderr.write(
        `${p.name}/${sample.scenario}: ${outcome.kind} ${Math.round(durationMs)}ms\n`,
      );
      return sample;
    };
    async function measure<T>(
      scenario: string,
      action: (signal: AbortSignal) => Promise<T>,
      phaseValues: Record<string, number> = {},
      clock?: PhaseClock,
      failureDetails: unknown = null,
    ) {
      const start = performance.now(),
        at = new Date().toISOString(),
        before = await host();
      const dependency = dependencies.get(scenario) ?? blockedBy;
      if (dependency && !["destroy", "restore-destroy", "snapshot-cleanup", "snapshot-total", "reconnect-cleanup"].includes(scenario)) {
        const sample = await add(scenario, "ms", { kind: "blocked", blocked_by: dependency, note: `Blocked by ${dependency}` }, start, at, before, failureDetails);
        return { kind: "unsuccessful" as const, sample };
      }
      try {
        const result = await deadline(timeout, (signal) =>
          pending.track(action(AbortSignal.any([signal, stopping.signal]))),
        );
        const sample = await add(
          scenario,
          "ms",
          { kind: "sample", value: clock?.elapsed() ?? performance.now() - start },
          start,
          at,
          before,
          result ?? null,
          phaseValues,
          clock,
        );
        return { kind: "success" as const, result, sample };
      } catch (error) {
        const sample = await add(
          scenario,
          "ms",
          error instanceof Skip
            ? { kind: "skipped", note: error.message }
            : { kind: "failure", note: errorNote(error) },
          start,
          at,
          before,
          failureDetails,
          phaseValues,
          clock,
        );
        if (!(error instanceof Skip)) {
          if (["cold", "reconnect", "pause-resume", "snapshot"].includes(scenario)) blockedBy ??= scenario;
          if (scenario === "fingerprint") dependencies.set("perf", scenario);
          const downstream: Record<string, string[]> = {
            "create-from-snapshot": ["restore-fingerprint"],
            "npm-install": ["dev-server", "preview-provisioning", "preview-first-byte", "edit-loop"],
            "preview-provisioning": ["dev-server", "preview-first-byte", "edit-loop"],
            "dev-server": ["preview-first-byte", "edit-loop"],
            "preview-first-byte": ["edit-loop"],
          };
          for (const target of downstream[scenario] ?? []) dependencies.set(target, dependencies.get(scenario) ?? scenario);
        }
        if (!(await pending.drain(timeout))) {
          unsafe = true;
          unsafeProviders.add(p.name);
          state.stop = "Timed-out work did not drain; stopped for cleanup safety";
        }
        return { kind: "unsuccessful" as const, sample };
      }
    }
    try {
      await measure(
        "cold",
        async (signal) => {
          box = await createSandbox(tracked, {
            labels: { "sandbox-bench-run": config.run },
            ports: [3000],
            signal,
            ...(p.name === "local" ? { size: "medium" } : {}),
          });
          await command(box, "true", timeout, signal);
          phases.firstCommandOKMs = performance.now() - lifeStart;
        },
        phases,
      );
      if (!box) return;
      let active: Sandbox = box;
      // A single guest exec for the fingerprint, including the 1s steal interval.
      await measure("fingerprint", async (signal) => {
        if (p.name === "memory") throw new Skip("Memory is an offline fake");
        const script = await readFile(new URL("../probes/fingerprint.py", import.meta.url), "utf8");
        const output = await command(
          active,
          `python3 - <<'BENCH_FINGERPRINT'\n${script}\nBENCH_FINGERPRINT`,
          timeout,
          signal,
        );
        fp = parseFingerprint(output);
        state.fp = fp;
        for (const sample of report.samples)
          if (sample.provider === p.name && sample.iteration === index && !sample.fingerprint) {
            sample.fingerprint = fp;
            sample.estimatedCost = estimateCost(p.name, sample.durationMs, resources(fp));
          }
        return fp;
      });
      if (burst) return;
      const groups = shuffle(
        [
          "command",
          "files-1kb",
          "files-10mb",
          "reconnect",
          "pause-resume",
          "snapshot",
          "perf",
          "git-clone",
          "app",
          "tool-replay",
          "pip-install",
        ],
        config.seed + index,
      );
      let fixture = false;
      for (const group of groups) {
        if (stopping.signal.aborted) break;
        if (unsafe) blockedBy ??= "pending-work";
        if (index >= config.runs && !workloadNames.has(group) && group !== "app") continue;
        if (workloadNames.has(group) && index >= (config["workload-runs"] ?? config.runs)) continue;
        const targets =
          group === "app"
            ? ["npm-install", "dev-server", "preview-first-byte", "edit-loop"]
            : [group];
        if (!targets.some(selected)) continue;
        if (group === "app") {
          if (index >= (config["workload-runs"] ?? config.runs)) continue;
          await measure("npm-install", async (signal) => {
            await uploadFixture(active);
            fixture = true;
            return command(
              active,
              "cd /workspace/bench-app && npm ci --ignore-scripts --no-audit --no-fund",
              timeout,
              signal,
            );
          });
          if (!targets.slice(1).some(selected)) continue;
          const preview = await measure("preview-provisioning", () => active.preview(3000));
          await measure("dev-server", async () => {
            if (preview.kind !== "success") throw new Error("Preview provisioning did not return a URL");
            const h = await active.start("npm run dev", {
              env: { BENCH_PREVIEW_HOST: new URL(preview.result.url).hostname },
              name: "bench-vite", cwd: "/workspace/bench-app", ready: { log: /Local:/ }, readyTimeoutMs: timeout,
            });
            if (!h.ready) throw new Error("Vite not ready");
          });
          if (selected("preview-first-byte")) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              const clock = new PhaseClock();
              const result = await measure("preview-first-byte", async (signal) => {
                if (preview.kind !== "success") throw new Error("Preview unavailable");
                await firstByteAttempt(preview.result, signal, clock, (work) => { void pending.track(work); });
                return { attempt };
              }, {}, clock, { attempt });
              if (result.kind === "success") {
                if (dependencies.get("edit-loop") === "preview-first-byte") dependencies.delete("edit-loop");
                break;
              }
              if (dependencies.has("preview-first-byte") || blockedBy || unsafe) break;
              if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
            }
          }
          if (selected("edit-loop"))
            await measure("edit-loop", async (signal) => {
              await active.files.edit("/workspace/bench-app/index.html", {
                find: "bench-initial",
                replace: "bench-edited",
              });
              while (!signal.aborted) {
                if ((await previewText(active, signal)).includes("bench-edited")) return;
                await new Promise((r) => setTimeout(r, 50));
              }
              throw new Error("Edited content not observed");
            });
          continue;
        }
        if (group === "snapshot") {
          const snapshotTotalStart = performance.now(), snapshotTotalAt = new Date().toISOString(), snapshotTotalHost = await host();
          let snapshotId: string | undefined;
          let snapshotReady = false;
          let clean: ((id: string) => Promise<void>) | undefined;
          const setup = await measure("snapshot-setup", async () => {
            if (!p.provider.capabilities.has("snapshot") || !p.provider.snapshot)
              throw new Skip("Provider has no snapshot");
            clean = await snapshotCleaner(p.name, p.provider, active.id);
            if (p.name === "daytona") {
              owned.set(`${p.name}/snapshot-source/${active.id}`, {
                provider: p.name, id: active.id, kind: "snapshot-source", parent: null,
              });
              snapshotId = `bench-${config.run.slice(0, 25)}-${crypto.randomUUID().slice(0, 8)}`;
              owned.set(`${p.name}/snapshot/${snapshotId}`, {
                provider: p.name,
                id: snapshotId,
                kind: "snapshot",
                parent: active.id,
              });
              await persist();
            }
            return true;
          });
          if (setup.kind !== "success") {
            dependencies.set("snapshot", "snapshot-setup");
          }
          const snapshotClock = new PhaseClock();
          const snapshot = await measure("snapshot", async (signal) => {
            if (!p.provider.snapshot) throw new Skip("Provider has no snapshot");
            snapshotClock.begin();
            let snap: { id: string };
            try {
              snap = snapshotId
                ? await createNamedDaytonaSnapshot(p.provider, active.id, snapshotId)
                : await p.provider.snapshot(active.id);
            } finally { snapshotClock.finish(); }
            snapshotId = snap.id;
            snapshotReady = true;
            owned.set(`${p.name}/snapshot/${snap.id}`, {
              provider: p.name,
              id: snap.id,
              kind: "snapshot",
              parent: active.id,
            });
            await persist();
            if (signal.aborted) {
              await clean?.(snap.id);
              owned.delete(`${p.name}/snapshot/${snap.id}`);
              await persist();
              throw new Error("Late snapshot cleaned after timeout");
            }
            return { snapshotId: snap.id };
          }, {}, snapshotClock);
          await add("snapshot-total", "ms", snapshot.kind === "success" ? { kind: "sample", value: performance.now() - snapshotTotalStart } : setup.kind !== "success" ? setup.sample.outcome : snapshot.sample.outcome, snapshotTotalStart, snapshotTotalAt, snapshotTotalHost);
          if (snapshotId && clean) {
            const id = snapshotId;
            let restored: Sandbox | undefined;
            const restoreStart = performance.now();
            try {
              if (snapshotReady)
                await measure("create-from-snapshot", async (signal) => {
                  const start = performance.now();
                  restored = await createSandbox(tracked, {
                    from: id,
                    labels: { "sandbox-bench-run": config.run },
                    ports: [3000],
                    signal,
                  });
                  const returnedMs = performance.now() - start;
                  await command(restored, "true", timeout, signal);
                  return { apiReturnedMs: returnedMs, firstCommandOKMs: performance.now() - start };
                });
            } finally {
              if (restored) {
                const restoredBox = restored;
                const sourceFingerprint: Fingerprint | null = fp;
                let restoredFingerprint: Fingerprint | null = null;
                try {
                  await measure("restore-fingerprint", async (signal) => {
                    const script = await readFile(
                      new URL("../probes/fingerprint.py", import.meta.url),
                      "utf8",
                    );
                    fp = restoredFingerprint = parseFingerprint(
                      await command(
                        restoredBox,
                        `python3 - <<'BENCH_FINGERPRINT'\n${script}\nBENCH_FINGERPRINT`,
                        timeout,
                        signal,
                      ),
                    );
                    return fp;
                  });
                } finally {
                  fp = sourceFingerprint;
                }
                await measure("restore-destroy", () => restoredBox.destroy());
                const restoredMs = performance.now() - restoreStart;
                restoredDurationMs += restoredMs;
                const cost = estimateCost(p.name, restoredMs, restoredFingerprint ? resources(restoredFingerprint) : (pricing[p.name]?.fixed ?? null));
                restoredCost = restoredCost === null || cost === null ? null : restoredCost + cost;
                for (const sample of report.samples) {
                  if (sample.provider === p.name && sample.iteration === index &&
                    ["create-from-snapshot", "restore-fingerprint", "restore-destroy"].includes(sample.scenario)) {
                    sample.sandboxId = restoredBox.id;
                    sample.fingerprint = restoredFingerprint;
                    sample.estimatedCost = estimateCost(p.name, sample.durationMs, restoredFingerprint ? resources(restoredFingerprint) : (pricing[p.name]?.fixed ?? null));
                  }
                }
              }
              await measure("snapshot-cleanup", async () => {
                await clean?.(id);
                owned.delete(`${p.name}/snapshot/${id}`);
                await persist();
              });
            }
          }
          continue;
        }
        if (group === "perf") {
          const probe = await measure("perf", async (signal) => {
            if (!fp) throw new Error("Fingerprint required to size all-core benchmark");
            const script = await readFile(new URL("../probes/perf.py", import.meta.url), "utf8");
            const cores = Math.min(64, Math.ceil(resources(fp).cpu));
            const output = await command(active,
              `BENCH_CORES=${cores} python3 - <<'BENCH_PERF'\n${script}\nBENCH_PERF`, timeout, signal);
            if (signal.aborted) throw new Error("Performance probe aborted");
            return perfSchema.parse(JSON.parse(output));
          });
          // Publish exactly once, after the deadline race has settled. Persistence is not guest work.
          const source = probe.sample;
          for (const [metric, unit] of Object.entries(perfMetrics)) {
            const value = probe.kind === "success" ? probe.result.metrics[metric] : undefined;
            const outcome: Outcome = probe.kind !== "success" ? source.outcome : value === undefined
              ? { kind: "failure", note: probe.result.notes.join("; ") || `Probe omitted ${metric}` }
              : { kind: "sample", value };
            const clock = new PhaseClock();
            clock.start = 0; clock.end = source.durationMs;
            clock.startedAt = source.startedAt; clock.finishedAt = source.finishedAt;
            await add(metric, unit, outcome, 0, source.startedAt, source.hostBefore,
              probe.kind === "success" ? probe.result : null, {}, clock, source.hostAfter);
          }
          continue;
        }
        const reconnectClock = group === "reconnect" ? new PhaseClock() : undefined;
        await measure(group, async (signal) => {
          switch (group) {
            case "command":
              return command(active, "true", timeout, signal);
            case "files-1kb":
            case "files-10mb": {
              const size = group === "files-1kb" ? 1024 : 10 * 1024 * 1024;
              const bytes = filePayloads.get(size);
              if (!bytes) throw new Error("Unprepared file payload");
              const path = `/workspace/bench-${size}.bin`;
              await active.files.write(path, bytes);
              if (!bytes.equals(await active.files.read(path, { as: "bytes" })))
                throw new Error("File bytes differ");
              return { bytes: size };
            }
            case "reconnect": {
              const previous = active;
              const start = performance.now();
              reconnectClock?.begin();
              const connected = await connectSandbox(tracked, active.id);
              const api = performance.now() - start;
              await command(connected, "true", timeout, signal);
              const firstCommandOKMs = performance.now() - start;
              reconnectClock?.finish();
              reconnectedHandles.push(previous);
              active = connected;
              box = connected;
              return { connectReturnedMs: api, firstCommandOKMs };
            }
            case "pause-resume": {
              if (!p.provider.capabilities.has("pause") || !p.provider.pause || !p.provider.resume)
                throw new Skip("Provider has no pause/resume");
              const start = performance.now();
              await p.provider.pause(active.id);
              const pauseMs = performance.now() - start;
              const r = performance.now();
              await p.provider.resume(active.id);
              const resumeReturnedMs = performance.now() - r;
              await command(active, "true", timeout, signal);
              return { pauseMs, resumeReturnedMs, resumeReadyMs: performance.now() - r };
            }
            case "git-clone":
              return command(active, cloneCommand, timeout, signal);
            case "tool-replay":
              if (!fixture) {
                await uploadFixture(active);
                fixture = true;
              }
              return replay(active, timeout);
            case "pip-install": {
              const script = await readFile(
                new URL("../probes/pip-install.py", import.meta.url),
                "utf8",
              );
              return command(
                active,
                `python3 - <<'BENCH_PIP'\n${script}\nBENCH_PIP`,
                timeout,
                signal,
              );
            }
            default:
              throw new Skip(`Unknown scenario ${group}`);
          }
        }, {}, reconnectClock);
      }
    } finally {
      await barrier?.();
      if (!(await pending.drain(timeout))) {
        unsafeProviders.add(p.name);
        state.stop = "Pending work could not drain; no further sandboxes scheduled";
      }
      for (const id of ids)
        await measure("destroy", () =>
          remove(p, id).then(() => {
            ids.delete(id);
          }),
        );
      if (!(await pending.drain(timeout))) {
        unsafeProviders.add(p.name);
        state.stop = "Cleanup could not drain";
      }
      // Provider clients are cached by sandbox ID, shared across local handles.
      // Closing an old handle earlier would detach the newly connected handle too.
      for (const previous of reconnectedHandles)
        await measure("reconnect-cleanup", () => previous.close());
      const duration = performance.now() - lifeStart;
      const sourceCost = estimateCost(
        p.name, duration, fp ? resources(fp) : (pricing[p.name]?.fixed ?? null),
      );
      const cost = sourceCost === null || restoredCost === null ? null : sourceCost + restoredCost;
      state.reserved -= reserve;
      if (cost !== null) state.estimatedUSD += budgetUSD(p.name, cost);
      else if (p.cloud) {
        state.estimatedUSD += reserve;
        state.stop ??= "Unknown cost/resources; reserved estimate charged to budget";
      }
      const lifetime = await add(
        "sandbox-lifetime",
        "ms",
        { kind: "sample", value: duration },
        lifeStart,
        startTime,
        hostStart,
        { estimatedCost: cost, restoredDurationMs },
        phases,
      );
      lifetime.estimatedCost = cost;
      if (!box) lifetime.outcome = { kind: "skipped", note: "Creation failed; billed lifetime unknown" };
      report.budgets[p.name] = {
        created: state.created,
        estimatedUSD: state.estimatedUSD,
        stop: state.stop,
      };
      await save();
    }
  }
  const jobs = roundRobin(
    ready.map((p) => p.name),
    Math.max(config.runs, config["workload-runs"] ?? config.runs),
  );
  await schedule(
    config.scenarios.includes("burst") && !config.scenarios.includes("all") ? [] : jobs,
    { global: config.concurrency, perProvider: config["provider-concurrency"] },
    async (job) => {
      const p = ready.find((p) => p.name === job.provider);
      if (p) await iteration(p, job.iteration);
    },
  );
  // Burst cohorts are isolated from normal iterations. K is bounded by configured account limits.
  for (let cohortIndex = 0; cohortIndex < config["burst-cohorts"]; cohortIndex++)
   for (const k of config.bursts)
    for (const p of ready) {
      const configured =
        config["account-limits"][p.name] ??
        { boxd: 50, e2b: 20, upstash: 10, freestyle: 10, tenki: 5 }[p.name] ??
        10;
      const account = Math.min(configured, p.name === "boxd" ? 50 : configured);
      const existing = await deadline(config["timeout-ms"], () => p.provider.list({}))
        .then((v) => v.length)
        .catch(() => account);
      if (k > Math.min(account - existing, config.concurrency)) {
        const info = report.providers.find((v) => v.name === p.name);
        if (info)
          info.note += `; burst ${k} skipped: account cap ${account}, ${existing} existing SDK sandboxes, global concurrency ${config.concurrency}`;
        continue;
      }
      const start = performance.now();
      const at = new Date().toISOString(),
        before = await host();
      const offset = report.samples.length;
      let arrived = 0;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const barrier = async () => {
        if (++arrived === k) release();
        await gate;
      };
      await Promise.all(Array.from({ length: k }, (_, i) => iteration(p, cohortIndex * k + i, k, barrier)));
      const cohort = report.samples.slice(offset).filter((s) => s.scenario === `burst-${k}/cold`);
      const success = cohort.filter((s) => s.outcome.kind === "sample").length;
      const cohortHostAfter = await host();
      report.samples.push({
        provider: p.name,
        iteration: cohortIndex,
        scenario: `burst-${k}/all-ready`,
        unit: "ms",
        startedAt: at,
        finishedAt: new Date().toISOString(),
        durationMs: performance.now() - start,
        sandboxId: null,
        outcome:
          success === k
            ? {
                kind: "sample",
                value: Math.max(...cohort.map((s) => Date.parse(s.finishedAt) - Date.parse(at))),
              }
            : {
                kind: cohort.length < k ? "skipped" : "failure",
                note: `${success}/${k} ready; ${cohort.length} attempted (budgets may prevent admission)`,
              },
        phases: {},
        hostBefore: before,
        hostAfter: cohortHostAfter,
        headroom: headroom(before, cohortHostAfter),
        fingerprint: null,
        estimatedCost: null,
        details: { k, cohort: cohortIndex, success, attempted: cohort.length },
      });
    }
  for (const p of ready) {
    const errors: string[] = [];
    for (const item of [...owned.values()].filter(
      (v) => v.provider === p.name && v.kind === "snapshot",
    )) {
      try {
        const clean = await snapshotCleaner(p.name, p.provider, item.parent ?? "");
        await deadline(config["timeout-ms"], () => clean(item.id));
        owned.delete(`${p.name}/snapshot/${item.id}`);
        await persist();
      } catch (e) { errors.push(errorNote(e)); }
    }
    const ids = new Set([...owned.values()]
      .filter((v) => v.provider === p.name && v.kind === "sandbox").map((v) => v.id));
    try {
      const listed = await deadline(config["timeout-ms"], () =>
        p.provider.list({ "sandbox-bench-run": config.run }));
      for (const item of listed)
        if (item.labels["sandbox-bench-run"] === config.run) ids.add(item.id);
    } catch (e) { errors.push(errorNote(e)); }
    for (const id of ids) {
      try { await remove(p, id); } catch (e) { errors.push(errorNote(e)); }
    }
    const remaining = new Set<string>();
    try {
      const after = await deadline(config["timeout-ms"], () =>
        p.provider.list({ "sandbox-bench-run": config.run }));
      for (const item of after)
        if (item.labels["sandbox-bench-run"] === config.run) remaining.add(item.id);
    } catch (e) { errors.push(errorNote(e)); }
    // A timed-out Daytona snapshot can appear after its initial deletion returned.
    // Retain the source marker until the VM is gone, then query only that owned source.
    for (const item of [...owned.values()].filter((v) => v.provider === p.name && v.kind === "snapshot-source")) {
      if (remaining.has(item.id) || errors.length) continue;
      try {
        for (const snapshot of await deadline(config["timeout-ms"], () => snapshotsFromDaytonaSandbox(item.id))) {
          const clean = await snapshotCleaner(p.name, p.provider, item.id);
          await deadline(config["timeout-ms"], () => clean(snapshot.id));
        }
        if ((await deadline(config["timeout-ms"], () => snapshotsFromDaytonaSandbox(item.id))).length) throw new Error("Source snapshots are still deleting");
        owned.delete(`${p.name}/snapshot-source/${item.id}`);
        await persist();
      } catch (e) { errors.push(errorNote(e)); }
    }
    for (const item of owned.values()) if (item.provider === p.name) remaining.add(item.id);
    if (remaining.size) errors.push("Ownership journal or listing still contains resources");
    if (unsafeProviders.has(p.name)) errors.push("Pending work did not settle; late creations remain possible");
    report.cleanup.push({ provider: p.name, remaining: [...remaining], error: errors.length ? errors.join("; ") : null });
  }
  report.finishedAt = new Date().toISOString();
  report.summaries = summarize(report.samples, config.seed);
  await persist();
  await save();
  await writeFile(join(runDir, "samples.ndjson"), report.samples.map((s) => JSON.stringify(s) + "\n").join(""));
  process.off("SIGINT", requestStop);
  process.off("SIGTERM", requestStop);
  return report;
}

import { createSandbox, connectSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import type { CreateInput } from "@opencoredev/sandbox-sdk/provider";
import { cpus, loadavg } from "node:os";
import { readFile, mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import type { ConfigV2 } from "./v2-config.js";
import type { LoadedProvider, ReadyProvider } from "./providers.js";
import type { ReportV2, Sample, HostSample, Outcome } from "./v2-model.js";
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
        skipped: rows.length - successes.length - failures,
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
) {
  await mkdir(resolve(config.out), { recursive: true });
  await writeFile(join(resolve(config.out), "run.json"), JSON.stringify({ runId: config.run }), { flag: "wx" });
  const report: ReportV2 = {
    schemaVersion: 2,
    runId: config.run,
    timestamp: new Date().toISOString(),
    finishedAt: "",
    config,
    host: { cpu: cpus()[0]?.model ?? "unknown", os: process.platform, runtime: process.version },
    samples: [],
    summaries: [],
    providers: loaded.map((p) => ({
      name: p.name,
      kind: p.kind,
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
      "Daytona snapshots use its native nameable API with a 300-second completion budget to journal a run-owned snapshot name before creation. The SDK wrapper retains recovery names in errors, but generates them internally. Other lifecycle calls use the common SDK. Snapshot timeout is retained as failure and cleanup uses only journaled names.",
      "Round-robin iteration admission, independent per-provider and global limits. Seeded scenario groups; dependencies (install → dev → preview → edit) retain order. Fingerprint first, cold first, destroy last. No warmup samples discarded.",
      "Cold/reconnect/resume/restore use client monotonic clock through a successful true command. API-return and readiness phase timestamps are recorded separately. Create API phase includes provider-native readiness but excludes SDK handle initialization.",
      "All failures retained; percentiles/CI describe successful observations only. Success rate uses Wilson 95% interval (skips excluded). Nearest rank, population stddev, 2000 seeded bootstrap resamples for p50 and mean. No outlier removal.",
      "Fingerprint includes public ipinfo.io lookup (optional); region and org are observed egress, not a promise about placement. Host counters are cumulative: difference before/after to derive CPU and network load.",
      "CPython fixed LCG iterations/s; all-core uses ceil of min(nproc, cgroup quota), capped at 64 with worker count recorded. Python version and CPU flags retained: runtime differences remain a confounder. 16 MiB memory copy; 64 MiB buffered sequential I/O; fsync writes and 256 random 4 KiB operations at queue depth 1. Reads may be cached; no O_DIRECT. Decimal MB/s.",
      "Network: 25,000,000 bytes from speed.cloudflare.com including TLS; mean of five TCP connects to 1.1.1.1:443. Egress geography, CDN caches, shared host load and provider caches are uncontrolled.",
      "Costs are estimates, not invoices; marginal usage only, excludes subscriptions/credits/transfer/persistent snapshot retention. Cost per scenario allocates its measured duration; sandbox-lifetime records include setup and idle time and must not be summed with scenario allocations. Upstash/boxd allocated-resource estimates are upper bounds. Unknown resources yield null, never zero.",
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
    ) => {
      const durationMs = performance.now() - start;
      const sample: Sample = {
        provider: p.name,
        iteration: index,
        scenario: burst ? `burst-${burst}/${scenario}` : scenario,
        unit,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs,
        sandboxId: box?.id ?? [...ids][0] ?? null,
        outcome,
        phases: { ...phaseValues },
        hostBefore: before,
        hostAfter: await host(),
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
    ) {
      const start = performance.now(),
        at = new Date().toISOString(),
        before = await host();
      try {
        const result = await deadline(timeout, (signal) =>
          pending.track(action(AbortSignal.any([signal, stopping.signal]))),
        );
        await add(
          scenario,
          "ms",
          { kind: "sample", value: performance.now() - start },
          start,
          at,
          before,
          result ?? null,
          phaseValues,
        );
        return result;
      } catch (error) {
        await add(
          scenario,
          "ms",
          error instanceof Skip
            ? { kind: "skipped", note: error.message }
            : { kind: "failure", note: errorNote(error) },
          start,
          at,
          before,
          null,
          phaseValues,
        );
        if (!(await pending.drain(timeout))) {
          unsafe = true;
          unsafeProviders.add(p.name);
          state.stop = "Timed-out work did not drain; stopped for cleanup safety";
        }
        return undefined;
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
        if (unsafe || stopping.signal.aborted) break;
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
          await measure("dev-server", async () => {
            const preview = await p.provider.previewUrl(active.id, 3000);
            const h = await active.start("npm run dev", {
              env: { BENCH_PREVIEW_HOST: new URL(preview.url).hostname },
              name: "bench-vite",
              cwd: "/workspace/bench-app",
              ready: { log: /Local:/ },
              readyTimeoutMs: timeout,
            });
            if (!h.ready) throw new Error("Vite not ready");
          });
          if (selected("preview-first-byte"))
            await measure("preview-first-byte", async (signal) => {
              const preview = await active.preview(3000);
              const attempts: string[] = [];
              while (!signal.aborted) {
                let retry = false;
                try {
                  const response = await fetch(preview.url, { headers: preview.headers, signal });
                  const reader = response.body?.getReader();
                  try {
                    const first = await reader?.read();
                    if (response.ok && first && !first.done && first.value.byteLength)
                      return { attempts };
                    if ([404, 502, 503, 504].includes(response.status)) {
                      attempts.push(`HTTP ${response.status}`);
                      retry = true;
                    } else throw new Error(`Preview HTTP ${response.status}, no first byte`);
                  } finally {
                    await reader?.cancel();
                  }
                } catch (error) {
                  if (
                    error instanceof Error &&
                    /certificate|socket|ECONN|fetch failed/i.test(error.message)
                  ) {
                    attempts.push(errorNote(error));
                    retry = true;
                  } else throw error;
                }
                if (retry) await new Promise((r) => setTimeout(r, 500));
              }
              throw new Error(
                `Preview never served a first byte: ${attempts.slice(-3).join("; ")}`,
              );
            });
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
          let snapshotId: string | undefined;
          let snapshotReady = false;
          let clean: ((id: string) => Promise<void>) | undefined;
          await measure("snapshot", async (signal) => {
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
            const snap = snapshotId
              ? await createNamedDaytonaSnapshot(p.provider, active.id, snapshotId)
              : await p.provider.snapshot(active.id);
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
              await clean(snap.id);
              owned.delete(`${p.name}/snapshot/${snap.id}`);
              await persist();
              throw new Error("Late snapshot cleaned after timeout");
            }
            return { snapshotId: snap.id };
          });
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
        await measure(group, async (signal) => {
          switch (group) {
            case "command":
              return command(active, "true", timeout, signal);
            case "files-1kb":
            case "files-10mb": {
              const size = group === "files-1kb" ? 1024 : 10 * 1024 * 1024;
              const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251),
                path = `/workspace/bench-${size}.bin`;
              await active.files.write(path, bytes);
              if (!Buffer.from(bytes).equals(await active.files.read(path, { as: "bytes" })))
                throw new Error("File bytes differ");
              return { bytes: size };
            }
            case "reconnect": {
              await active.close();
              const start = performance.now();
              const connected = await connectSandbox(tracked, active.id);
              const api = performance.now() - start;
              await command(connected, "true", timeout, signal);
              active = connected;
              box = connected;
              return { connectReturnedMs: api, firstCommandOKMs: performance.now() - start };
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
            case "perf": {
              if (!fp) throw new Error("Fingerprint required to size all-core benchmark");
              const perfStart = performance.now(),
                perfAt = new Date().toISOString(),
                perfHost = await host();
              const script = await readFile(new URL("../probes/perf.py", import.meta.url), "utf8");
              const cores = Math.min(64, Math.ceil(resources(fp).cpu));
              const output = await command(
                active,
                `BENCH_CORES=${cores} python3 - <<'BENCH_PERF'\n${script}\nBENCH_PERF`,
                timeout,
                signal,
              );
              const data = perfSchema.parse(JSON.parse(output));
              const start = perfStart,
                at = perfAt,
                before = perfHost;
              for (const [metric, value] of Object.entries(data.metrics))
                await add(
                  metric,
                  metric === "tcp-ms"
                    ? "ms"
                    : metric.includes("iops")
                      ? "IOPS"
                      : metric.startsWith("cpu")
                        ? "iterations/s"
                        : "MB/s",
                  { kind: "sample", value },
                  start,
                  at,
                  before,
                  data,
                );
              for (const missing of ["network-mbps", "tcp-ms"].filter((n) => !(n in data.metrics)))
                await add(
                  missing,
                  missing === "tcp-ms" ? "ms" : "MB/s",
                  { kind: "failure", note: data.notes.join("; ") },
                  start,
                  at,
                  before,
                );
              return data;
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
        });
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
      await add(
        "sandbox-lifetime",
        "ms",
        { kind: "sample", value: duration },
        lifeStart,
        startTime,
        hostStart,
        { estimatedCost: cost, restoredDurationMs },
        phases,
      );
      const lifetime = report.samples.at(-1);
      if (lifetime) lifetime.estimatedCost = cost;
      if (!box) {
        const last = report.samples.at(-1);
        if (last)
          last.outcome = { kind: "skipped", note: "Creation failed; billed lifetime unknown" };
      }
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
      await Promise.all(Array.from({ length: k }, (_, i) => iteration(p, i, k, barrier)));
      const cohort = report.samples.slice(offset).filter((s) => s.scenario === `burst-${k}/cold`);
      const success = cohort.filter((s) => s.outcome.kind === "sample").length;
      report.samples.push({
        provider: p.name,
        iteration: 0,
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
        hostAfter: await host(),
        fingerprint: null,
        estimatedCost: null,
        details: { k, success, attempted: cohort.length },
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

import { createSandbox } from "@opencoredev/sandbox-sdk";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import type { CreateInput } from "@opencoredev/sandbox-sdk/provider";
import type { Config } from "./config.js";
import type { ReadyProvider } from "./providers.js";
import {
  scenarios,
  type Metric,
  type Observation,
  type ProviderReport,
  type Scenario,
} from "./model.js";
import { statistics } from "./stats.js";
import { deadline, pool, PendingWork } from "./timing.js";
import { cpuPerCall, overheadHooks, type OverheadFixture } from "./overhead.js";

class SkippedScenario extends Error {}
const note = (error: unknown) =>
  error instanceof Error ? error.message : "Unknown benchmark failure";
const payloads = new Map(
  [1024, 10 * 1024 * 1024].map((size) => [
    size,
    Uint8Array.from({ length: size }, (_, index) => index % 251),
  ]),
);
const server =
  'require("node:http").createServer((req,res)=>res.end("sandbox-bench\\n")).listen(3000,"0.0.0.0",()=>console.log("BENCH_READY"))';
export async function measureProvider(
  loaded: ReadyProvider,
  config: Config,
): Promise<Extract<ProviderReport, { kind: "measured" }>> {
  const values = new Map<Scenario, Observation[]>(scenarios.map((scenario) => [scenario, []]));
  const warmupFailures: string[] = [],
    cleanupFailures: string[] = [];
  function record(scenario: Scenario, observation: Observation, warmup: boolean) {
    if (!warmup) values.get(scenario)?.push(observation);
    else if (observation.kind === "failure")
      warmupFailures.push(`${scenario}: ${observation.note}`);
  }
  let stopScheduling = false;
  const drainMs = Math.max(1000, config["timeout-ms"]);
  async function iteration(warmup: boolean) {
    if (stopScheduling) return;
    const pending = new PendingWork();
    const nativeIds = new Set<string>();
    // Bind unmodified methods to the original adapter, including class instances.
    const scopedProvider = new Proxy(loaded.provider, {
      get(target, key) {
        if (key === "create")
          return (input: CreateInput) =>
            pending.track(
              (async () => {
                const info = await target.create(input);
                nativeIds.add(info.id);
                if (input.signal?.aborted) {
                  await deleteNative(info.id);
                  throw new Error("Late native creation cleaned up after timeout");
                }
                return info;
              })(),
            );
        if (key === "destroy")
          return (id: string) =>
            pending.track(
              (async () => {
                await target.destroy(id);
                nativeIds.delete(id);
              })(),
            );
        const member: unknown = Reflect.get(target, key, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
    async function deleteNative(id: string) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await deadline(config["timeout-ms"], () => pending.track(loaded.provider.destroy(id)));
          nativeIds.delete(id);
          return;
        } catch {
          /* Retry once, then retain the ID for the report. */
        }
      }
      stopScheduling = true;
      const message = `Could not destroy sandbox ${id}; manual cleanup required`;
      if (!cleanupFailures.includes(message)) cleanupFailures.push(message);
    }
    let box: Sandbox | undefined;
    let destroyed = false;
    let failed = false;
    async function measure(scenario: Scenario, action: (signal: AbortSignal) => Promise<void>) {
      if (failed) {
        record(
          scenario,
          { kind: "skipped", note: "Earlier scenario failed in this iteration" },
          warmup,
        );
        return;
      }
      const start = performance.now();
      try {
        await deadline(config["timeout-ms"], (signal) => pending.track(action(signal)));
        record(scenario, { kind: "sample", value: performance.now() - start }, warmup);
      } catch (error) {
        if (error instanceof SkippedScenario)
          record(scenario, { kind: "skipped", note: error.message }, warmup);
        else {
          record(scenario, { kind: "failure", note: note(error) }, warmup);
          failed = true;
        }
      }
    }
    try {
      await measure("cold", async (signal) => {
        const created = await createSandbox(scopedProvider, {
          ports: [3000],
          signal,
          ...(["memory", "e2b", "daytona"].includes(loaded.name) ? { timeoutMs: Math.min(3_600_000, config["timeout-ms"] * 10) } : {}),
          labels: { "sandbox-bench": "1" },
        });
        box = created;
        if (signal.aborted) {
          await created.destroy();
          destroyed = true;
          throw new Error("Creation completed after timeout; sandbox destroyed");
        }
        const result = await created.run("true", { signal, timeoutMs: config["timeout-ms"] });
        if (!result.ok) throw new Error("First command did not succeed");
      });
      const active = box;
      if (!active || failed) {
        for (const scenario of [
          "command",
          "files-1kb",
          "files-10mb",
          "dev-server",
          "preview-first-byte",
        ] satisfies Scenario[])
          record(
            scenario,
            { kind: "skipped", note: "Sandbox creation / first command failed" },
            warmup,
          );
        return;
      }
      await measure("command", async (signal) => {
        const result = await active.run("true", { signal, timeoutMs: config["timeout-ms"] });
        if (!result.ok) throw new Error("Command did not succeed");
      });
      for (const [size, bytes] of payloads)
        await measure(size === 1024 ? "files-1kb" : "files-10mb", async () => {
          const path = `/workspace/bench-${size}.bin`;
          await active.files.write(path, bytes);
          const read = await active.files.read(path, { as: "bytes" });
          if (!Buffer.from(bytes).equals(read))
            throw new Error(`File round trip corrupted ${size} bytes`);
        });
      if (loaded.name === "memory") {
        record(
          "dev-server",
          { kind: "skipped", note: "Memory does not launch Node or bind sockets" },
          warmup,
        );
        record(
          "preview-first-byte",
          { kind: "skipped", note: "Memory previews use .memory.invalid; no HTTP request made" },
          warmup,
        );
      } else {
        await measure("dev-server", async () => {
          await active.files.write("/workspace/bench-server.cjs", server);
          const process = await active.start("node /workspace/bench-server.cjs", {
            name: "bench-server",
            ready: { log: /BENCH_READY/ },
            readyTimeoutMs: config["timeout-ms"],
          });
          if (!process.ready) throw new Error("Dev server did not become ready");
        });
        await measure("preview-first-byte", async (signal) => {
          const preview = await active.preview(3000);
          const url = new URL(preview.url);
          if (!["http:", "https:"].includes(url.protocol) || url.hostname.endsWith(".invalid"))
            throw new SkippedScenario("Provider returned no real HTTP preview URL");
          const response = await fetch(url, { headers: preview.headers, signal });
          const reader = response.body?.getReader();
          try {
            if (!response.ok || !reader)
              throw new Error(`Preview returned HTTP ${response.status}`);
            const first = await reader.read();
            if (first.done || !first.value.byteLength) throw new Error("Preview returned no bytes");
          } finally {
            await reader?.cancel();
          }
        });
      }
    } finally {
      // Destroy is independent of prior scenario failures. Retry once if it fails.
      if (box && !destroyed) {
        const target = box;
        const start = performance.now();
        try {
          await deadline(config["timeout-ms"], () => pending.track(target.destroy()));
          destroyed = true;
          nativeIds.delete(target.id);
          record("destroy", { kind: "sample", value: performance.now() - start }, warmup);
        } catch (error) {
          record("destroy", { kind: "failure", note: note(error) }, warmup);
          await deleteNative(target.id);
        }
      } else if (!box)
        record(
          "destroy",
          {
            kind: "skipped",
            note: "No sandbox handle acquired; tracking late native creation for cleanup",
          },
          warmup,
        );
      // Do not release the worker or start CPU measurements while timed-out work runs.
      const settled = await pending.drain(drainMs);
      if (!settled) {
        stopScheduling = true;
        cleanupFailures.push(
          "Timed-out adapter work did not settle within the cleanup grace period; remaining iterations and CPU measurements stopped. Late creations still have deletion callbacks attached.",
        );
      }
      for (const id of nativeIds) await deleteNative(id);
      if (!(await pending.drain(drainMs))) stopScheduling = true;
    }
  }
  await pool(config.warmup, config.concurrency, () => iteration(true));
  await pool(config.runs, config.concurrency, () => iteration(false));
  if (stopScheduling) {
    const remaining = config.runs - (values.get("cold")?.length ?? 0);
    for (const scenario of scenarios.filter((value) => !value.endsWith("cpu"))) {
      for (let index = 0; index < remaining; index++)
        record(
          scenario,
          { kind: "skipped", note: "Iteration not started because previous cleanup was unsafe" },
          false,
        );
    }
  }
  // CPU measurements are serial and isolated from latency workers (process-wide counters).
  const hook = overheadHooks[loaded.name];
  if (!hook || stopScheduling) {
    for (const scenario of ["raw-cpu", "sdk-cpu", "overhead-cpu"] satisfies Scenario[])
      record(
        scenario,
        {
          kind: "skipped",
          note: stopScheduling
            ? "CPU measurement stopped because adapter work is still pending"
            : "No mocked-native CPU hook registered for this provider",
        },
        false,
      );
  } else {
    let fixture: OverheadFixture | undefined;
    const pending = new PendingWork();
    const disposed = new Set<OverheadFixture>();
    async function dispose(value: OverheadFixture) {
      if (disposed.has(value)) return;
      disposed.add(value);
      try {
        await deadline(config["timeout-ms"], () => pending.track(value.dispose()));
      } catch {
        cleanupFailures.push("CPU hook fixture cleanup failed");
      }
    }
    try {
      const active = await deadline(config["timeout-ms"], (signal) =>
        pending.track(
          hook().then(async (value) => {
            fixture = value;
            if (signal.aborted) await dispose(value);
            return value;
          }),
        ),
      );
      for (let index = -config.warmup; index < config.runs; index++) {
        // Alternate order to reduce systematic JIT/GC ordering bias.
        let raw = 0,
          sdk = 0;
        try {
          await deadline(config["timeout-ms"], () =>
            pending.track(
              (async () => {
                if (index % 2 === 0) {
                  raw = await cpuPerCall(active.rawCall);
                  sdk = await cpuPerCall(active.sdkCall);
                } else {
                  sdk = await cpuPerCall(active.sdkCall);
                  raw = await cpuPerCall(active.rawCall);
                }
              })(),
            ),
          );
          for (const [scenario, value] of [
            ["raw-cpu", raw],
            ["sdk-cpu", sdk],
            ["overhead-cpu", sdk - raw],
          ] satisfies [Scenario, number][])
            record(scenario, { kind: "sample", value }, index < 0);
        } catch (error) {
          for (const scenario of ["raw-cpu", "sdk-cpu", "overhead-cpu"] satisfies Scenario[])
            record(scenario, { kind: "failure", note: note(error) }, index < 0);
          break;
        }
      }
    } catch (error) {
      for (const scenario of ["raw-cpu", "sdk-cpu", "overhead-cpu"] satisfies Scenario[])
        record(scenario, { kind: "failure", note: note(error) }, false);
    } finally {
      if (!(await pending.drain(drainMs)))
        cleanupFailures.push(
          "CPU hook work did not settle within cleanup grace; late fixture disposal remains attached",
        );
      if (fixture) await dispose(fixture);
      if (!(await pending.drain(drainMs)))
        cleanupFailures.push("CPU fixture disposal did not settle within cleanup grace");
    }
  }
  const metrics: Metric[] = scenarios.map((scenario) => {
    const observations = values.get(scenario) ?? [];
    const samples = observations.flatMap((value) => (value.kind === "sample" ? [value.value] : []));
    return {
      scenario,
      unit: scenario.endsWith("cpu") ? "cpu-ms/call" : "ms",
      samples,
      stats: statistics(samples),
      failures: observations.flatMap((value) => (value.kind === "failure" ? [value.note] : [])),
      skipped: observations.flatMap((value) => (value.kind === "skipped" ? [value.note] : [])),
    };
  });
  return {
    kind: "measured",
    name: loaded.name,
    region: loaded.region,
    metrics,
    notes: [(["memory", "e2b", "daytona"].includes(loaded.name) ? "Creation lifetime requested; " : "Creation lifetime omitted for this provider; ") + "tracked cleanup destroys acquired and late-arriving sandboxes. No idle timeout requested.", ...(loaded.name === "local" ? ["Local CPU uses mocked Docker exec and an in-memory filesystem; no Docker socket or container is used for CPU measurements."] : [])],
    warmupFailures,
    cleanupFailures,
  };
}

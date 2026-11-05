/**
 * Idle time between work, under the two frozen idle policies.
 *
 * - "provider-defaults": the sandbox is left open; the harness waits on its side and makes no call.
 *   Whatever the provider does on its own (standby, auto-pause) is what is measured.
 * - "managed": after a gap longer than the frozen threshold (60 s), the harness calls the provider's
 *   documented pause through the adapter, waits, and resumes before the next step. It is used only where
 *   the state-preservation check passed: filesystem, background process and in-memory marker all kept.
 *
 * The held-open diagnostic is: the profile's workload, one idle period (10 or 60 minutes), then the
 * frozen resume steps (`git status` and the test suite). Its zero-wait twin uses an idle of 0.
 */
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { quote } from "../workloads.js";
import type { Clock, ProviderTrace } from "./gaps.js";
import type { IdleRecord } from "./record.js";

/** Frozen before the pilot: managed idle acts only on gaps longer than this. */
export const managedIdleThresholdMs = 60_000;

export type IdlePolicy = IdleRecord["policy"];

export interface IdlePlan {
  policy: IdlePolicy;
  idleMs: number;
  thresholdMs?: number;
}

/** What the adapter exposes for managed idle. `stop` has no portable adapter call. */
export interface ManagedIdleCapabilities {
  pause: boolean;
  snapshot: boolean;
  stop: false;
}

export function managedIdleCapabilities(provider: Provider): ManagedIdleCapabilities {
  return {
    pause:
      provider.capabilities.has("pause") &&
      provider.pause !== undefined &&
      provider.resume !== undefined,
    snapshot: provider.capabilities.has("snapshot") && provider.snapshot !== undefined,
    stop: false,
  };
}

/** The sandbox's state from a label-filtered list: a read that neither wakes nor resumes it. */
async function observedState(provider: Provider, box: Sandbox) {
  try {
    const matches = await provider.list(box.labels);

    return matches.find((info) => info.id === box.id)?.state ?? null;
  } catch {
    return null;
  }
}

export interface IdleOutcome extends Omit<IdleRecord, "wakeLatencyMs"> {
  spans: { name: "idle" | "gap"; startedAt: number; endedAt: number; label: string }[];
}

/** Hold the sandbox idle under `plan`. Throws only when the signal aborts. */
export async function holdIdle(input: {
  box: Sandbox;
  provider: Provider;
  trace: ProviderTrace;
  clock: Clock;
  plan: IdlePlan;
  signal: AbortSignal;
}): Promise<IdleOutcome> {
  const { box, provider, trace, clock, plan, signal } = input;
  const stateBefore = await observedState(provider, box);
  const startedAt = clock.now();
  const threshold = plan.thresholdMs ?? managedIdleThresholdMs;
  const managed = plan.policy === "managed" && plan.idleMs > threshold;
  let suspendMs: number | null = null;
  let restoreMs: number | null = null;
  let waited: { startedAt: number; endedAt: number };

  if (managed) {
    if (!managedIdleCapabilities(provider).pause)
      throw new Error("Managed idle needs a state-preserving pause; this provider has none");
    const suspendStart = clock.now();
    await provider.pause?.(box.id);
    suspendMs = clock.now() - suspendStart;
    waited = await trace.wait("idle", Math.max(0, plan.idleMs - suspendMs), signal);
    const restoreStart = clock.now();
    await provider.resume?.(box.id);
    restoreMs = clock.now() - restoreStart;
  } else waited = await trace.wait("idle", plan.idleMs, signal);
  const endedAt = clock.now();
  const stateAfter = managed ? "running" : await observedState(provider, box);

  return {
    policy: plan.policy,
    requestedMs: plan.idleMs,
    mechanism: managed ? "pause" : null,
    stateBefore,
    stateAfter,
    suspendMs,
    restoreMs,
    trafficDuringIdle: trace.trafficDuring(waited).length,
    spans: [{ name: "idle", startedAt, endedAt, label: plan.policy }],
  };
}

export type StatePreservation =
  | {
      verdict: "state-preserving" | "restore-and-rebuild";
      mechanism: "pause";
      filesystem: boolean;
      process: boolean;
      memory: boolean;
      suspendMs: number;
      restoreMs: number;
    }
  | { verdict: "unavailable"; reason: string };

const markerProcess = "rw-state-marker";

/**
 * The capability check that runs before any managed-idle run on a provider: suspend and resume a sandbox
 * holding a file marker, a background process and an in-memory marker, then check all three survived.
 * The in-memory token is generated inside the process and only printed on SIGUSR1, so a restarted
 * process (cold restore) cannot answer with it.
 */
export async function checkStatePreservation(input: {
  box: Sandbox;
  provider: Provider;
  clock: Clock;
  workdir: string;
  holdMs: number;
  signal: AbortSignal;
}): Promise<StatePreservation> {
  const { box, provider, clock, workdir, signal } = input;

  if (!managedIdleCapabilities(provider).pause)
    return { verdict: "unavailable", reason: "No pause and resume in the adapter" };
  const fileToken = randomBytes(16).toString("hex");
  const markerPath = posix.join(workdir, ".rw/state-marker");
  await box.files.write(markerPath, fileToken);

  const handle = await box.start(
    `M=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n'); trap 'echo "marker=$M"' USR1; echo "init=$M pid=$$"; while :; do sleep 1 & wait $!; done`,
    { name: markerProcess, ready: { log: /init=[0-9a-f]+ pid=\d+/ }, readyTimeoutMs: 30_000 },
  );

  const init = /init=([0-9a-f]+) pid=(\d+)/.exec((await handle.logs()).text);
  const token = init?.[1];
  const pid = init?.[2];

  if (!token || !pid) return { verdict: "unavailable", reason: "Marker process did not start" };
  const suspendStart = clock.now();
  await provider.pause?.(box.id);
  const suspendMs = clock.now() - suspendStart;
  await clock.sleep(input.holdMs, signal);
  const restoreStart = clock.now();
  await provider.resume?.(box.id);
  const restoreMs = clock.now() - restoreStart;

  const filesystem = await box.files
    .read(markerPath)
    .then((text) => text === fileToken)
    .catch(() => false);

  const info = (await box.processes().catch(() => [])).find((item) => item.name === markerProcess);
  const process = info?.status === "running";
  let memory = false;

  if (process) {
    await box.run(`kill -USR1 ${quote(pid)}`, { timeoutMs: 10_000, signal });

    for (let tries = 0; tries < 20 && !memory; tries++) {
      memory = (await handle.logs()).text.includes(`marker=${token}`);

      if (!memory) await clock.sleep(250, signal);
    }
  }

  await handle.stop({ graceMs: 1_000 }).catch(() => undefined);

  return {
    verdict: filesystem && process && memory ? "state-preserving" : "restore-and-rebuild",
    mechanism: "pause",
    filesystem,
    process,
    memory,
    suspendMs,
    restoreMs,
  };
}

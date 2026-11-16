/**
 * The step runner. A non-zero exit is data: each step is run, observed, and decided only by its frozen
 * check (`checks.ts`). Steps follow cause, not the clock: a step waits for the steps it depends on,
 * then for its think gap measured from their completion (a harness-side wait), then for the readiness
 * of any background process it needs, and only then runs.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ProcessHandle, Sandbox } from "@opencoredev/sandbox-sdk";
import { quote } from "../workloads.js";
import { evaluateCheck, type CheckFailure, type TestOutcome } from "./checks.js";
import type { Clock, ProviderTrace } from "./gaps.js";
import {
  dependenciesOf,
  expand,
  type BackgroundSpec,
  type OutputInvariants,
  type Placeholders,
  type Profile,
  type Step,
  type StepPhase,
} from "./manifest.js";

/** Recorded blobs and patches, by hash. `get` must verify the hash of what it returns. */
export interface BlobStore {
  get(sha256: string): Promise<Uint8Array>;
}

export function sha256Hex(data: Uint8Array | string) {
  return createHash("sha256").update(data).digest("hex");
}

/** Blobs held in memory, hash-checked on insert. */
export function memoryBlobs(blobs: Iterable<Uint8Array>): BlobStore {
  const byHash = new Map<string, Uint8Array>();

  for (const blob of blobs) byHash.set(sha256Hex(blob), blob);

  return {
    async get(sha256) {
      const blob = byHash.get(sha256);

      if (!blob) throw new Error(`Blob ${sha256} is not in the store`);

      return blob;
    },
  };
}

export interface StepContext {
  box: Sandbox;
  clock: Clock;
  trace: ProviderTrace;
  signal: AbortSignal;
  /** Absolute working directory of this attempt. */
  workdir: string;
  placeholders: Placeholders;
  commands: Profile["commands"];
  env: Record<string, string>;
  /** Directories put first on PATH (the pinned toolchain and package manager). */
  path: string[];
  blobs: BlobStore;
  defaultTimeoutMs: number;
  /** Raw output, kept for inspection; never used to decide success. */
  onOutput?(stepId: string, output: string): void;
}

interface GapRecord {
  requestedMs: number;
  startedAt: number;
  endedAt: number;
}

interface RanStep {
  id: string;
  phase: StepPhase;
  gating: boolean;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  timedOut: boolean;
  outputBytes: number;
  outputSha256: string;
  invariants: OutputInvariants;
  failures: CheckFailure[];
  excluded: TestOutcome[];
  gap: GapRecord | null;
}

export type StepResult =
  | ({ status: "passed" } & RanStep)
  | ({ status: "failed" } & RanStep)
  | { status: "blocked"; id: string; phase: StepPhase; gating: boolean; blockedBy: string };

export interface BackgroundEvent {
  id: string;
  startStep: string;
  startedAt: number;
  readyAt: number | null;
  stoppedAt: number | null;
  shutdown: "step" | "harness" | "exited" | "session-end" | "running";
}

/** fix-and-test and build stop at the first failed gating step; a session replay continues. */
export type FailurePolicy = "stop" | "continue";

export function failurePolicy(kind: Profile["kind"]): FailurePolicy {
  return kind === "session" ? "continue" : "stop";
}

const outputLimit = 8 * 1024 * 1024;

export class StepRunner {
  readonly background = new Map<string, { spec: BackgroundSpec; handle: ProcessHandle }>();
  readonly events: BackgroundEvent[] = [];
  readonly results = new Map<string, StepResult>();
  private stopped: string | null = null;

  constructor(private readonly context: StepContext) {}

  private absolute(relative: string) {
    return relative === "." ? this.context.workdir : posix.join(this.context.workdir, relative);
  }

  private script(step: Step) {
    const { op } = step;

    const body =
      op.kind === "command"
        ? (this.context.commands[op.name] ?? "")
        : op.kind === "shell"
          ? op.script
          : "";

    const path = this.context.path.map((entry) => quote(entry)).join(":");
    const prefix = path ? `export PATH=${path}:"$PATH"; ` : "";

    return prefix + expand(body, this.context.placeholders);
  }

  private env() {
    return Object.fromEntries(
      Object.entries(this.context.env).map(([key, value]) => [
        key,
        expand(value, this.context.placeholders),
      ]),
    );
  }

  private async hashes(paths: string[], cwd: string): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = Object.fromEntries(
      paths.map((path) => [path, null]),
    );

    if (!paths.length) return result;

    const run = await this.context.box.run(
      `sha256sum -- ${paths.map((path) => quote(path)).join(" ")} 2>/dev/null; true`,
      { cwd, timeoutMs: 120_000, signal: this.context.signal },
    );

    for (const line of run.stdout.split("\n")) {
      const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);

      if (match?.[1] && match[2] && match[2] in result) result[match[2]] = match[1];
    }

    return result;
  }

  private async ready(name: string, deadline: number): Promise<boolean> {
    const entry = this.background.get(name);

    if (!entry) return false;
    const event = this.events.find((item) => item.id === name);

    if (event?.readyAt) return true;

    if (event?.stoppedAt) return false;
    const { readiness } = entry.spec;

    for (;;) {
      let ok = false;

      if (readiness.kind === "line") {
        const logs = await entry.handle.logs().catch(() => ({ text: "" }));
        ok = new RegExp(readiness.pattern, "m").test(logs.text);
      } else {
        const probe = await this.context.box.run(
          `bash -c ${quote(`exec 3<>/dev/tcp/127.0.0.1/${readiness.port}`)}`,
          { timeoutMs: 5_000, signal: this.context.signal },
        );

        ok = probe.exitCode === 0;
      }

      if (ok) {
        if (event) event.readyAt = this.context.clock.now();

        return true;
      }

      if (this.context.clock.now() >= deadline || this.context.signal.aborted || event?.stoppedAt)
        return false;
      await this.context.clock.sleep(250, this.context.signal).catch(() => undefined);
    }
  }

  /** Run one step now: no gap, no dependency wait. */
  async execute(step: Step, gap: GapRecord | null): Promise<StepResult> {
    const { box, clock, signal } = this.context;
    const cwd = this.absolute(step.cwd);
    const failures: CheckFailure[] = [];

    for (const need of step.needs) {
      const spec = this.background.get(need)?.spec;
      const timeoutMs = spec?.readinessTimeoutMs ?? 0;

      if (!(await this.ready(need, clock.now() + timeoutMs)))
        failures.push({ kind: "readiness", process: need, timeoutMs });
    }

    const startedAt = clock.now();
    let exitCode: number | null = 0;
    let timedOut = false;
    let output = "";
    let testReport: string | null = null;

    try {
      if (failures.length) exitCode = null;
      else if (step.background) {
        const handle = await box.start(this.script(step), {
          name: step.background.id,
          cwd,
          env: this.env(),
        });

        this.background.set(step.background.id, { spec: step.background, handle });
        this.events.push({
          id: step.background.id,
          startStep: step.id,
          startedAt,
          readyAt: null,
          stoppedAt: null,
          shutdown: "running",
        });
      } else if (step.op.kind === "write") {
        await box.files.write(
          this.absolute(step.op.path),
          await this.context.blobs.get(step.op.blob),
        );
      } else if (step.op.kind === "read") {
        output = await box.files.read(this.absolute(step.op.path));
      } else if (step.op.kind === "command" || step.op.kind === "shell") {
        if (step.check.testReport)
          await box.run(`rm -f -- ${quote(this.absolute(step.check.testReport.path))}`, {
            cwd,
            signal,
          });

        const result = await box.run(this.script(step), {
          cwd,
          env: this.env(),
          timeoutMs: step.timeoutMs ?? this.context.defaultTimeoutMs,
          maxOutputBytes: outputLimit,
          signal,
        });

        exitCode = result.exitCode;
        timedOut = result.timedOut;
        output = result.output;

        if (step.check.testReport)
          testReport = await box.files
            .read(this.absolute(step.check.testReport.path))
            .catch(() => null);
      }
    } catch (error) {
      exitCode = null;
      failures.push({
        kind: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const endedAt = clock.now();
    const { postconditions } = step.check;
    const paths = [...Object.keys(postconditions.files), ...postconditions.exists];
    const fileHashes = failures.length ? {} : await this.hashes(paths, this.context.workdir);
    this.context.onOutput?.(step.id, output);

    const check = evaluateCheck(step.background ? { ...step.check, exit: "any" } : step.check, {
      exitCode: failures.length ? 0 : exitCode,
      timedOut,
      output,
      testReport,
      fileHashes,
      paths: { workdir: this.context.workdir },
    });

    const ran: RanStep = {
      id: step.id,
      phase: step.phase,
      gating: step.gating,
      startedAt,
      endedAt,
      exitCode,
      timedOut,
      outputBytes: new TextEncoder().encode(output).byteLength,
      outputSha256: sha256Hex(output),
      invariants: check.invariants,
      failures: [...failures, ...check.failures],
      excluded: check.excluded,
      gap,
    };

    return ran.failures.length ? { status: "failed", ...ran } : { status: "passed", ...ran };
  }

  /** Stop background processes whose recorded shutdown is this step. */
  private async shutdownAfter(stepId: string) {
    for (const [id, { spec, handle }] of this.background) {
      if (spec.shutdown.kind !== "step" || spec.shutdown.step !== stepId) continue;
      await this.stop(id, handle);
    }
  }

  private async stop(id: string, handle: ProcessHandle, end = false) {
    const event = this.events.find((item) => item.id === id);

    if (!event || event.stoppedAt !== null) return;

    const info = (await this.context.box.processes().catch(() => [])).find(
      (process) => process.name === id,
    );

    const running = info?.status === "running" || info?.status === "starting";

    if (running) await handle.stop({ graceMs: 2_000 }).catch(() => undefined);
    event.stoppedAt = this.context.clock.now();
    event.shutdown = running ? (end ? "session-end" : "harness") : end ? "exited" : "step";
  }

  /** Stop every process still running at the end of the session. */
  async stopAll() {
    for (const [id, { handle }] of this.background) await this.stop(id, handle, true);
  }

  /**
   * Run `steps` (one phase of `profile`) by cause. Dependencies on steps outside `steps` must already
   * be in `results`. Steps with independent prerequisites overlap, as they did in the recording.
   */
  async run(profile: Pick<Profile, "steps">, steps: readonly Step[], policy: FailurePolicy) {
    const { clock, trace, signal } = this.context;
    const startedAt = clock.now();
    const done = new Map<string, Promise<StepResult>>();
    const indexOf = new Map(profile.steps.map((step, index) => [step.id, index]));

    const settle = async (id: string): Promise<StepResult | undefined> =>
      this.results.get(id) ?? (await done.get(id));

    const runOne = async (step: Step): Promise<StepResult> => {
      const deps = dependenciesOf(profile, indexOf.get(step.id) ?? 0);
      const prerequisites = await Promise.all(deps.map((id) => settle(id)));

      const blocked = (blockedBy: string): StepResult => ({
        status: "blocked",
        id: step.id,
        phase: step.phase,
        gating: step.gating,
        blockedBy,
      });

      for (const [index, prerequisite] of prerequisites.entries()) {
        const id = deps[index] ?? "unknown";

        if (!prerequisite) return blocked(id);

        if (prerequisite.status === "blocked") return blocked(prerequisite.blockedBy);
      }

      if (this.stopped) return blocked(this.stopped);

      if (signal.aborted) return blocked("aborted");

      const after = Math.max(
        startedAt,
        ...prerequisites.map((item) => (item && item.status !== "blocked" ? item.endedAt : 0)),
      );

      let gap: GapRecord | null = null;

      if (step.gapAfterPrereqMs > 0) {
        const wait = Math.max(0, after + step.gapAfterPrereqMs - clock.now());

        try {
          const window = await trace.wait(step.id, wait, signal);
          gap = { requestedMs: step.gapAfterPrereqMs, ...window };
        } catch {
          return blocked("aborted");
        }
      }

      if (this.stopped) return blocked(this.stopped);

      const result = await trace.working(step.id, async () => {
        const outcome = await this.execute(step, gap);
        this.results.set(step.id, outcome);
        await this.shutdownAfter(step.id);

        return outcome;
      });

      if (
        result.status === "failed" &&
        result.gating &&
        (policy === "stop" || result.timedOut) &&
        !this.stopped
      )
        this.stopped = step.id;

      return result;
    };

    for (const step of steps) done.set(step.id, runOne(step));
    const results = await Promise.all(steps.map((step) => done.get(step.id)));

    for (const result of results) if (result) this.results.set(result.id, result);

    return results.filter((result): result is StepResult => result !== undefined);
  }
}

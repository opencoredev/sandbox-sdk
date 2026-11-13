/**
 * Harness-side idle. A think gap is a wait in this process: nothing runs in the sandbox, no exec stream
 * stays open, and nothing we control sends a keepalive. `traceProvider` records every adapter call with
 * its time, so a run can prove that no call reached the provider inside any gap window.
 */
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { providerMember } from "../providers.js";

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Real time. `sleep` never returns early: timers may fire a millisecond before the target. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
      const target = Date.now() + ms;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("Aborted"));
      };

      const check = () => {
        const left = target - Date.now();

        if (left > 0) {
          timer = setTimeout(check, left);

          return;
        }

        signal?.removeEventListener("abort", abort);
        resolve();
      };

      signal?.addEventListener("abort", abort, { once: true });
      check();
    }),
};

export interface ProviderCall {
  member: string;
  startedAt: number;
  endedAt: number | null;
}

/** A harness-side wait, recorded so traffic inside it can be counted afterwards. */
export interface GapWindow {
  /** The step the gap precedes, or the idle period's label. */
  before: string;
  startedAt: number;
  endedAt: number;
}

/** A span in which a step (or harness bookkeeping right after it) was working in the sandbox. */
export interface ActiveWindow {
  label: string;
  startedAt: number;
  endedAt: number | null;
}

export class ProviderTrace {
  readonly calls: ProviderCall[] = [];
  readonly gaps: GapWindow[] = [];
  readonly active: ActiveWindow[] = [];

  constructor(private readonly clock: Clock) {}

  begin(member: string) {
    const call: ProviderCall = { member, startedAt: this.clock.now(), endedAt: null };
    this.calls.push(call);

    return () => {
      call.endedAt = this.clock.now();
    };
  }

  /** Wait on our side and record the window. No provider call is made. */
  async wait(before: string, ms: number, signal?: AbortSignal): Promise<GapWindow> {
    const startedAt = this.clock.now();
    await this.clock.sleep(ms, signal);
    const gap = { before, startedAt, endedAt: this.clock.now() };
    this.gaps.push(gap);

    return gap;
  }

  /** Run `action` as active work. Calls inside it are that step's, even during a sibling's gap. */
  async working<T>(label: string, action: () => Promise<T>): Promise<T> {
    const window: ActiveWindow = { label, startedAt: this.clock.now(), endedAt: null };
    this.active.push(window);

    try {
      return await action();
    } finally {
      window.endedAt = this.clock.now();
    }
  }

  private covered(call: ProviderCall) {
    return this.active.some(
      (window) =>
        window.startedAt <= call.startedAt &&
        (window.endedAt === null || (call.endedAt !== null && call.endedAt <= window.endedAt)),
    );
  }

  /**
   * Calls that overlapped a gap and belong to no active step. An empty list is the requirement: when
   * steps overlap (as they did in the recording), one step's work during another's gap is not idle
   * traffic, but anything else is, including keepalives or polling.
   */
  trafficDuring(gap: Pick<GapWindow, "startedAt" | "endedAt">) {
    return this.calls.filter(
      (call) =>
        call.startedAt < gap.endedAt &&
        (call.endedAt === null || call.endedAt > gap.startedAt) &&
        !this.covered(call),
    );
  }

  /** Every call that overlapped any recorded gap. */
  gapTraffic() {
    return this.gaps.flatMap((gap) =>
      this.trafficDuring(gap).map((call) => ({ gap: gap.before, ...call })),
    );
  }
}

function timed<A extends unknown[], R>(
  trace: ProviderTrace,
  member: string,
  method: (...args: A) => Promise<R>,
) {
  return async (...args: A): Promise<R> => {
    const done = trace.begin(member);

    try {
      return await method(...args);
    } finally {
      done();
    }
  };
}

function tracedFiles(source: Provider["files"], trace: ProviderTrace): Provider["files"] {
  return new Proxy(source, {
    get(target, key) {
      switch (key) {
        case "read":
          return timed(trace, "files.read", target.read.bind(target));
        case "write":
          return timed(trace, "files.write", target.write.bind(target));
        case "list":
          return timed(trace, "files.list", target.list.bind(target));
        case "stat":
          return timed(trace, "files.stat", target.stat.bind(target));
        case "remove":
          return timed(trace, "files.remove", target.remove.bind(target));
        case "mkdir":
          return timed(trace, "files.mkdir", target.mkdir.bind(target));
        case "readRange":
          return target.readRange && timed(trace, "files.readRange", target.readRange.bind(target));
        case "watch":
          return target.watch && timed(trace, "files.watch", target.watch.bind(target));
        case "guestInput":
          return (
            target.guestInput && timed(trace, "files.guestInput", target.guestInput.bind(target))
          );
        case "transfer":
          return target.transfer;
        case "checkpoints":
          return target.checkpoints;
        case "writeCreatesParents":
          return target.writeCreatesParents;
        case "editInGuest":
          return target.editInGuest;
        case "listOrder":
          return target.listOrder;
        case "writeSupportsMode":
          return target.writeSupportsMode;
        case "internal":
          return target.internal;
        default:
          return undefined;
      }
    },
  });
}

/** The adapter methods that reach the provider. Each is timed; everything else passes through. */
function tracedMember(target: Provider, key: string | symbol, trace: ProviderTrace) {
  switch (key) {
    case "create":
      return timed(trace, key, target.create.bind(target));
    case "find":
      return timed(trace, key, target.find.bind(target));
    case "connect":
      return timed(trace, key, target.connect.bind(target));
    case "list":
      return timed(trace, key, target.list.bind(target));
    case "destroy":
      return timed(trace, key, target.destroy.bind(target));
    case "exec":
      return timed(trace, key, target.exec.bind(target));
    case "previewUrl":
      return timed(trace, key, target.previewUrl.bind(target));
    case "close":
      return target.close && timed(trace, key, target.close.bind(target));
    case "usage":
      return target.usage && timed(trace, key, target.usage.bind(target));
    case "pause":
      return target.pause && timed(trace, key, target.pause.bind(target));
    case "resume":
      return target.resume && timed(trace, key, target.resume.bind(target));
    case "snapshot":
      return target.snapshot && timed(trace, key, target.snapshot.bind(target));
    case "terminal":
      return target.terminal && timed(trace, key, target.terminal.bind(target));
    case "deleteSnapshot":
      return target.deleteSnapshot && timed(trace, key, target.deleteSnapshot.bind(target));
    case "buildTemplate":
      return target.buildTemplate && timed(trace, key, target.buildTemplate.bind(target));
    case "startProcess":
      // A native process hook can keep a client-side monitor polling the provider through think gaps,
      // invisible to this tracer. Hide it, so background processes use the SDK's detached shell
      // records, unless the runtime has no shell ("stream" mode) and needs the hook.
      return target.processMode === "stream" && target.startProcess
        ? timed(trace, key, target.startProcess.bind(target))
        : undefined;
    case "readSecretEnvironment":
      return (
        target.readSecretEnvironment && timed(trace, key, target.readSecretEnvironment.bind(target))
      );
    default:
      return providerMember(target, key);
  }
}

/**
 * Wrap an adapter so every call that reaches the provider is timed in `trace`. This sees adapter calls
 * only; traffic an adapter makes on its own (transport keepalives) needs a network capture in the pilot.
 */
export function traceProvider(provider: Provider, trace: ProviderTrace): Provider {
  const files = tracedFiles(provider.files, trace);

  return new Proxy(provider, {
    get(target, key) {
      return key === "files" ? files : tracedMember(target, key, trace);
    },
  });
}

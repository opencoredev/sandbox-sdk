/** A fake `disk` module: sandboxes are MockGuest directories, processes are real local shells. */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { CreateSandboxRequest } from "disk";
import type { ArchilModule } from "../src/providers/archil/provider.js";
import type {
  ArchilOutput,
  ArchilProcess,
  ArchilProcessResult,
  ArchilRunOptions,
} from "../src/providers/archil/execute.js";
import { MockGuest } from "./mock-guest.js";

type Status = "pending" | "running" | "pausing" | "paused" | "stopped" | "failed" | "deleted";

class FakeApiError extends Error {
  override name = "ArchilApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface ArchilState {
  sandboxes: Map<string, FakeSandbox>;
  creates: CreateSandboxRequest[];
  runs: string[];
  /** Fail the next create without an HTTP answer, after making the sandbox. */
  dropNextCreateAnswer: boolean;
  /** Drop the first output message that starts at or past this stream offset, once. */
  dropOutputAbove: number | undefined;
  /** Refuse the next create with this HTTP status before allocating anything. */
  refuseNextCreate: number | undefined;
  /** New sandboxes start pending and then end in this state on their first refresh. */
  settleTo: Status | undefined;
  /** Pause the sandbox just as a command containing this text starts, once. */
  pauseOnCommand: string | undefined;
  /** Refuse the next process start with this HTTP status, once. */
  refuseNextRun: number | undefined;
  /** Pause the sandbox while a command containing this text runs, cutting its stream, once. */
  pauseDuringCommand: string | undefined;
  /**
   * For a command containing `command`, once: Archil closes the process connection after `bytes`
   * output bytes (the message crossing it delivered only up to it), so nothing more arrives and
   * `wait` rejects at once, the process still running. `attach` replays the rest and reports the
   * exit, as Archil's does.
   */
  closeConnection: { command: string; bytes: number } | undefined;
  /** Offsets every `attach` was asked to replay from. */
  attachOffsets: number[];
  /** Fail this many `attach` handshakes, with no HTTP answer. */
  failAttaches: number;
  /** Hold every `attach` this long before it answers. */
  attachDelayMs: number;
  /** Per-attach holds, in order, before `attachDelayMs` applies. */
  attachDelays: number[];
  /** Hold a kill this long before the process actually ends, as Archil's report can lag. */
  killDelayMs: number;
  /** Connections `attach` made, with whether each was disconnected. */
  attached: { disconnected: boolean }[];
}

export const archilState: ArchilState = {
  sandboxes: new Map<string, FakeSandbox>(),
  creates: new Array<CreateSandboxRequest>(),
  runs: new Array<string>(),
  /** Fail the next create without an HTTP answer, after making the sandbox. */
  dropNextCreateAnswer: false,
  /** Drop the first output message that starts at or past this stream offset, once. */
  dropOutputAbove: undefined,
  refuseNextCreate: undefined,
  settleTo: undefined,
  pauseOnCommand: undefined,
  refuseNextRun: undefined,
  pauseDuringCommand: undefined,
  closeConnection: undefined,
  attachOffsets: [],
  failAttaches: 0,
  attachDelayMs: 0,
  attachDelays: [],
  killDelayMs: 0,
  attached: [],
};

/** Every process the fake started, by ID, so `attach` can find a finished one too. */
const processes = new Map<string, FakeProcess>();

class FakeProcess implements ArchilProcess {
  readonly id = crypto.randomUUID();
  /** The sandbox that started it. */
  sandbox = "";
  cursor = 0;
  /** Every output message, delivered or not, for `attach` to replay. */
  readonly log: ArchilOutput[] = [];
  /** Live output listeners an attach added. */
  readonly listeners = new Set<(output: ArchilOutput) => void>();
  /** Closes the connection that owns the process now; a new attach takes it over (Archil's rule). */
  closeOwner = () => {};
  /** Output past this many bytes is not delivered on this connection (Archil closed it). */
  closedAfter: number | undefined;
  /** Rejects once this connection is closed early. */
  #closed: Promise<never> | undefined;
  #close = () => {};
  readonly #child: ChildProcess;
  readonly #ended: Promise<ArchilProcessResult>;
  #killed = false;
  #disconnected = false;
  #timedOut = false;

  constructor(
    guest: MockGuest,
    command: string,
    options: ArchilRunOptions,
    sandboxEnv: Record<string, string> = {},
  ) {
    const env = Object.fromEntries(
      Object.entries({ ...sandboxEnv, ...options.env }).map(([key, value]) => [
        key,
        guest.rewrite(value),
      ]),
    );

    this.#child = spawn("sh", ["-c", guest.rewrite(command)], {
      cwd: guest.root,
      detached: true,
      env: { PATH: process.env.PATH, HOME: guest.root, ...env },
    });

    const strip = (data: Buffer) =>
      new Uint8Array(Buffer.from(data.toString("latin1").split(guest.root).join(""), "latin1"));

    const deliver = (stream: "stdout" | "stderr", data: Uint8Array) => {
      // Archil counts one offset across both streams.
      const offset = this.cursor;
      this.cursor += data.length;
      this.log.push({ stream, offset, data });

      for (const listener of this.listeners) listener({ stream, offset, data });

      // A disconnected client gets nothing more, nor one whose connection Archil closed.
      if (this.#disconnected) return;

      if (this.closedAfter !== undefined && offset + data.length > this.closedAfter) {
        // The message crossing the cut arrives only up to it; the connection then closes.
        if (offset < this.closedAfter)
          options.onOutput?.({ stream, offset, data: data.subarray(0, this.closedAfter - offset) });
        this.#close();

        return;
      }

      // Like Archil's stream under load: a message past the drop threshold skips its bytes.
      if (archilState.dropOutputAbove !== undefined && offset >= archilState.dropOutputAbove) {
        archilState.dropOutputAbove = undefined;

        return;
      }

      options.onOutput?.({ stream, offset, data });
    };

    this.#child.stdout?.on("data", (data: Buffer) => deliver("stdout", strip(data)));
    this.#child.stderr?.on("data", (data: Buffer) => deliver("stderr", strip(data)));

    const timer =
      options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            this.#timedOut = true;
            this.#group("SIGKILL");
          }, options.timeoutSeconds * 1000);

    this.#ended = new Promise((resolve) => {
      this.#child.on("exit", () => this.#group("SIGKILL"));
      this.#child.on("close", (code) => {
        clearTimeout(timer);

        if (this.#timedOut) resolve({ status: "timed_out" });
        else if (this.#killed) resolve({ status: "cancelled" });
        else resolve({ status: "completed", exitCode: code ?? 137 });
      });
    });
  }

  #group(signal: NodeJS.Signals) {
    try {
      if (this.#child.pid) process.kill(-this.#child.pid, signal);
    } catch {}
  }

  async sendInput(data: string | Uint8Array) {
    this.#child.stdin?.write(data);
  }
  async closeStdin() {
    this.#child.stdin?.end();
  }
  async resize() {}
  /** Set when the sandbox paused under this process: its stream is cut, as Archil does. */
  cut: Promise<never> | undefined;
  /** The process's own end, whatever this connection saw. */
  get ended() {
    return this.#ended;
  }
  /** Close this connection early when it reaches `closedAfter` (closeConnection). */
  closeAt(bytes: number) {
    this.closedAfter = bytes;
    this.#closed = new Promise<never>((_, reject) => {
      this.#close = () => reject(new Error("Process connection closed before exit"));
    });
    this.#closed.catch(() => {});
  }
  wait() {
    if (this.#closed !== undefined) return this.#closed;

    return this.cut === undefined ? this.#ended : Promise.race([this.#ended, this.cut]);
  }
  async kill() {
    this.#killed = true;
    const delay = archilState.killDelayMs;

    if (delay > 0) setTimeout(() => this.#group("SIGKILL"), delay);
    else this.#group("SIGKILL");
  }
  async disconnect() {
    this.#disconnected = true;
  }
}

class FakeSandbox {
  status: Status = "pending";
  maxTtlSeconds = 86_400;
  env: Record<string, string> = {};
  readonly createdAt = new Date();
  readonly files = {
    downloadFile: async (path: string, write: (chunk: Uint8Array) => void) => {
      const bytes = await readFile(this.guest.rewrite(path));

      for (let offset = 0; offset < bytes.length; offset += 512 * 1024)
        write(new Uint8Array(bytes.subarray(offset, offset + 512 * 1024)));
    },
  };
  constructor(
    readonly id: string,
    readonly name: string,
    readonly guest: MockGuest,
  ) {}
  async run(command: string, options: ArchilRunOptions = {}) {
    if (this.status === "deleted") throw new FakeApiError("Sandbox not found", 404, "not_found");

    if (archilState.refuseNextRun !== undefined) {
      const status = archilState.refuseNextRun;
      archilState.refuseNextRun = undefined;
      throw new FakeApiError("Service unavailable", status, "unavailable");
    }

    if (archilState.pauseOnCommand !== undefined && command.includes(archilState.pauseOnCommand)) {
      archilState.pauseOnCommand = undefined;
      this.status = "paused";
    }

    if (this.status !== "running")
      throw new FakeApiError("Sandbox is not running", 409, "sandbox_not_running");
    archilState.runs.push(command);
    const process = new FakeProcess(this.guest, command, options, this.env);
    process.sandbox = this.id;
    processes.set(process.id, process);

    if (archilState.closeConnection && command.includes(archilState.closeConnection.command)) {
      process.closeAt(archilState.closeConnection.bytes);
      archilState.closeConnection = undefined;
    }

    if (
      archilState.pauseDuringCommand !== undefined &&
      command.includes(archilState.pauseDuringCommand)
    ) {
      archilState.pauseDuringCommand = undefined;
      this.status = "paused";
      process.cut = Promise.reject(new Error("Process connection closed"));
      process.cut.catch(() => {});
    }

    return process;
  }
  /** A new connection to a process, finished or not: its output from `offset`, then its end. */
  async attach(
    processId: string,
    options: { offset?: number; onOutput?: (output: ArchilOutput) => void } = {},
  ): Promise<ArchilProcess> {
    archilState.attachOffsets.push(options.offset ?? 0);

    const hold = archilState.attachDelays.shift() ?? archilState.attachDelayMs;

    if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));

    if (archilState.failAttaches > 0) {
      archilState.failAttaches--;
      throw new Error("Process connection closed during the handshake");
    }

    // A new connection needs the sandbox running, as Archil's connection endpoint does.
    if (this.status !== "running")
      throw new FakeApiError("Sandbox is not running", 409, "sandbox_not_running");
    const target = processes.get(processId);

    if (!target) throw new FakeApiError("Process not found", 404, "not_found");
    const from = options.offset ?? 0;
    let detached = false;
    const record = { disconnected: false };
    archilState.attached.push(record);

    // Archil gives the process to the newest connection and closes the one that had it.
    target.closeOwner();
    let closeMine = () => {};

    const closed = new Promise<never>((_, reject) => {
      closeMine = () => {
        detached = true;
        reject(new Error("Process connection closed: another connection took the process"));
      };
    });

    closed.catch(() => {});
    target.closeOwner = closeMine;

    const send = ({ stream, offset, data }: ArchilOutput) => {
      if (detached || offset + data.length <= from) return;
      const skip = Math.max(0, from - offset);
      options.onOutput?.({ stream, offset: offset + skip, data: data.subarray(skip) });
    };

    for (const output of target.log) send(output);
    target.listeners.add(send);

    return {
      id: processId,
      get cursor() {
        return target.cursor;
      },
      sendInput: (data) => target.sendInput(data),
      closeStdin: () => target.closeStdin(),
      resize: async () => {},
      wait: () => Promise.race([target.ended, closed]),
      kill: () => target.kill(),
      disconnect: async () => {
        detached = true;
        record.disconnected = true;
        target.listeners.delete(send);
        // Like disk's handle: a disconnected connection no longer reports the end.
        closeMine();
      },
    };
  }
  async refresh() {
    if (this.status === "deleted") throw new FakeApiError("Sandbox not found", 404, "not_found");

    if (this.status === "pending") this.status = archilState.settleTo ?? "running";

    return this;
  }
  async start() {
    this.status = "running";

    return this;
  }
  async stop() {
    this.status = "stopped";

    return this;
  }
  async pause() {
    this.status = "paused";

    return this;
  }
  async resume() {
    // Archil refuses a resume until the pause has settled.
    if (this.status !== "paused" && this.status !== "running")
      throw new FakeApiError("Sandbox is not paused", 409, "sandbox_not_paused");
    this.status = "running";

    return this;
  }
  async delete() {
    if (this.status !== "stopped" && this.status !== "failed")
      throw new FakeApiError("Sandbox must be stopped", 409, "sandbox_not_stopped");
    this.status = "deleted";
    archilState.sandboxes.delete(this.id);

    // Its processes and their output go with it.
    for (const [id, process] of processes) if (process.sandbox === this.id) processes.delete(id);
    await this.guest.destroy();
  }
  async exposePort(port: number) {
    return `${port}-${this.id}.sandbox.archil.test`;
  }
}

class FakeArchil {
  sandboxes = {
    create: async (request: CreateSandboxRequest) => {
      archilState.creates.push(request);

      if (archilState.refuseNextCreate !== undefined) {
        const status = archilState.refuseNextCreate;
        archilState.refuseNextCreate = undefined;
        throw new FakeApiError("Service unavailable", status, "unavailable");
      }

      const guest = await MockGuest.create();

      // Archil checks and takes a name in one step, and a taken name lists at once.
      if ([...archilState.sandboxes.values()].some((box) => box.name === request.name)) {
        await guest.destroy();
        throw new FakeApiError(
          "A sandbox with this name already exists",
          409,
          "sandbox_name_conflict",
        );
      }

      const box = new FakeSandbox(guest.id, request.name ?? guest.id, guest);
      box.env = { ...request.env };
      box.maxTtlSeconds = request.maxTtlSeconds ?? 86_400;
      box.status = "running";
      archilState.sandboxes.set(box.id, box);

      if (archilState.settleTo !== undefined) box.status = "pending";

      if (archilState.dropNextCreateAnswer) {
        archilState.dropNextCreateAnswer = false;
        throw new TypeError("fetch failed");
      }

      return box;
    },
    get: async (id: string) => {
      const box = archilState.sandboxes.get(id);

      if (!box) throw new FakeApiError("Sandbox not found", 404, "not_found");

      return box;
    },
    list: async () => [...archilState.sandboxes.values()],
  };
}

/** Adds a sandbox the SDK did not make, as another Archil client would. */
export async function addForeign(name: string, status: Status) {
  const guest = await MockGuest.create();
  const box = new FakeSandbox(guest.id, name, guest);
  box.status = status;
  archilState.sandboxes.set(box.id, box);

  return box;
}

/** The fake module, typed as the adapter's `disk` loader expects. */
export const fakeDisk: ArchilModule = {
  // SAFETY: the adapter calls only the members FakeArchil and FakeSandbox implement.
  Archil: FakeArchil as never,
};

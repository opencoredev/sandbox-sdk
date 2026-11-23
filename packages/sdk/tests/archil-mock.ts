/** A fake `disk` module: sandboxes are MockGuest directories, processes are real local shells. */
import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { CreateSandboxRequest } from "disk";
import type { ArchilModule } from "../src/providers/archil/provider.js";
import type {
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
};

class FakeProcess implements ArchilProcess {
  cursor = 0;
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

      // A disconnected client gets nothing more.
      if (this.#disconnected) return;

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
  wait() {
    return this.cut === undefined ? this.#ended : Promise.race([this.#ended, this.cut]);
  }
  async kill() {
    this.#killed = true;
    this.#group("SIGKILL");
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

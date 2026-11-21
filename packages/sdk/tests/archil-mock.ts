/** A fake `disk` module: sandboxes are MockGuest directories, processes are real local shells. */
import { spawn, type ChildProcess } from "node:child_process";
import type { CreateSandboxRequest } from "disk";
import type { ArchilModule } from "../src/providers/archil/provider.js";
import type {
  ArchilProcess,
  ArchilProcessResult,
  ArchilRunOptions,
} from "../src/providers/archil/execute.js";
import { MockGuest } from "./mock-guest.js";

type Status = "pending" | "running" | "paused" | "stopped" | "deleted";

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

export const archilState = {
  sandboxes: new Map<string, FakeSandbox>(),
  creates: new Array<CreateSandboxRequest>(),
  runs: new Array<string>(),
  /** Fail the next create without an HTTP answer, after making the sandbox. */
  dropNextCreateAnswer: false,
};

class FakeProcess implements ArchilProcess {
  readonly #child: ChildProcess;
  readonly #ended: Promise<ArchilProcessResult>;
  #killed = false;
  #timedOut = false;

  constructor(guest: MockGuest, command: string, options: ArchilRunOptions) {
    const env = Object.fromEntries(
      Object.entries(options.env ?? {}).map(([key, value]) => [key, guest.rewrite(value)]),
    );

    this.#child = spawn("sh", ["-c", guest.rewrite(command)], {
      cwd: guest.root,
      detached: true,
      env: { PATH: process.env.PATH, HOME: guest.root, ...env },
    });

    const strip = (data: Buffer) =>
      new Uint8Array(Buffer.from(data.toString("latin1").split(guest.root).join(""), "latin1"));

    this.#child.stdout?.on("data", (data: Buffer) =>
      options.onOutput?.({ stream: "stdout", data: strip(data) }),
    );
    this.#child.stderr?.on("data", (data: Buffer) =>
      options.onOutput?.({ stream: "stderr", data: strip(data) }),
    );

    const timer =
      options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            this.#timedOut = true;
            this.#group("SIGKILL");
          }, options.timeoutSeconds * 1000);

    this.#ended = new Promise((resolve) => {
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
  wait() {
    return this.#ended;
  }
  async kill() {
    this.#killed = true;
    this.#group("SIGKILL");
  }
  async disconnect() {}
}

class FakeSandbox {
  status: Status = "running";
  readonly createdAt = new Date();
  constructor(
    readonly id: string,
    readonly name: string,
    readonly guest: MockGuest,
  ) {}
  async run(command: string, options: ArchilRunOptions = {}) {
    if (this.status === "deleted") throw new FakeApiError("Sandbox not found", 404, "not_found");

    if (this.status !== "running")
      throw new FakeApiError("Sandbox is not running", 409, "sandbox_not_running");
    archilState.runs.push(command);

    return new FakeProcess(this.guest, command, options);
  }
  async refresh() {
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
    this.status = "running";

    return this;
  }
  async delete() {
    if (this.status !== "stopped")
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

      if ([...archilState.sandboxes.values()].some((box) => box.name === request.name))
        throw new FakeApiError(
          "A sandbox with this name already exists",
          409,
          "sandbox_name_conflict",
        );
      const guest = await MockGuest.create();
      const box = new FakeSandbox(guest.id, request.name ?? guest.id, guest);
      archilState.sandboxes.set(box.id, box);

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

/** The fake module, typed as the adapter's `disk` loader expects. */
export const fakeDisk: ArchilModule = {
  // SAFETY: the adapter calls only the members FakeArchil and FakeSandbox implement.
  Archil: FakeArchil as never,
};

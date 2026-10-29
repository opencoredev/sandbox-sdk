import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { Boxd, BoxdOptions } from "@boxd-sh/sdk/web";
import { loadPeer } from "../../peer.js";
import { boxdError, failure } from "./errors.js";

type Transfer =
  | { kind: "upload"; machine: string; path: string; bytes: Uint8Array }
  | { kind: "download"; machine: string; path: string };

type Result = number | Uint8Array;

// SDK 0.2.17's clientStream has neither a deadline nor a cancel handle, and
// close() is a no-op. Keep its fetches in an isolated realm we can terminate.
// The worker is source text, not a function's toString(): a consumer's bundler
// can inject helpers into a function (esbuild --keep-names adds __name) that the
// worker would not have. Dynamic import works in both CommonJS eval workers and
// parents launched with --input-type=module.
const workerSource = `import("node:worker_threads").then(async ({ parentPort, workerData }) => {
  const { Boxd } = await import(workerData.moduleURL);
  const client = new Boxd(workerData.options);
  parentPort.on("message", async request => {
    try {
      const value = request.kind === "upload"
        ? await client.machines.files.upload(request.machine, request.path, request.bytes)
        : await client.machines.files.download(request.machine, request.path);
      parentPort.postMessage({ requestId: request.requestId, value });
    } catch (error) {
      // Never send native messages, paths, credentials or stacks over IPC.
      const message = error instanceof Error ? error.message : "";
      parentPort.postMessage({ requestId: request.requestId, error: {
        name: error instanceof Error ? error.name : "Error",
        grpcCode: typeof error === "object" && error !== null && typeof error.grpcCode === "number" ? error.grpcCode : undefined,
        permissionDenied: /permission denied/i.test(message),
        missingFile: /\\bno such file\\b/i.test(message),
      } });
    }
  });
});`;

/**
 * The file URL of `@boxd-sh/sdk/web` for the worker, or undefined when there is no file to load.
 * A CommonJS bundle has no `import.meta.url`, Turbopack resolves to a module ID rather than a path,
 * and a deploy without node_modules has nothing on disk, so the app directory is tried as well.
 */
function webModuleURL(): string | undefined {
  // Read through a variable: a CommonJS bundle compiles import.meta to an empty object.
  const meta: { url?: unknown } = import.meta;

  for (const base of [meta.url, pathToFileURL(join(process.cwd(), "index.js")).href]) {
    if (typeof base !== "string") continue;

    try {
      const path: unknown = createRequire(base).resolve("@boxd-sh/sdk/web");

      if (typeof path === "string" && isAbsolute(path)) return pathToFileURL(path).href;
    } catch {
      /* try the next base */
    }
  }

  return undefined;
}

export class FileTransfers {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private stopping = new Map<Worker, { machine?: string; promise: Promise<void> }>();
  private nextId = 0;
  private pending = new Map<
    number,
    {
      worker: Worker;
      machine: string;
      resolve(value: Result): void;
      reject(error: unknown): void;
      cleanup(): void;
    }
  >();
  /** Undefined until the first transfer; null when the SDK has no file on disk for a worker to load. */
  private moduleURL: string | null | undefined;
  private inline?: Promise<Boxd>;
  constructor(
    private readonly options: BoxdOptions,
    private readonly signal?: AbortSignal,
  ) {}

  private start(moduleURL: string) {
    const idle = this.idle.pop();

    if (idle) return idle;

    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { moduleURL, options: this.options },
    });

    this.workers.add(worker);
    worker.on("message", (reply: unknown) => {
      if (!this.workers.has(worker)) return;

      if (
        !reply ||
        typeof reply !== "object" ||
        !("requestId" in reply) ||
        typeof reply.requestId !== "number"
      ) {
        void this.stop(worker, failure("Invalid file transfer response"));

        return;
      }

      const pending = this.pending.get(reply.requestId);

      if (!pending || pending.worker !== worker) return;
      this.pending.delete(reply.requestId);
      pending.cleanup();

      if (
        "value" in reply &&
        (typeof reply.value === "number" || reply.value instanceof Uint8Array)
      ) {
        pending.resolve(reply.value);
      } else if ("error" in reply && reply.error && typeof reply.error === "object") {
        const error = reply.error;

        const message =
          "permissionDenied" in error && error.permissionDenied === true
            ? "permission denied"
            : "missingFile" in error && error.missingFile === true
              ? "no such file"
              : "File transfer failed";

        pending.reject(
          boxdError(
            Object.assign(new Error(message), {
              name: "name" in error && typeof error.name === "string" ? error.name : "Error",
              grpcCode:
                "grpcCode" in error && typeof error.grpcCode === "number"
                  ? error.grpcCode
                  : undefined,
            }),
            pending.machine,
          ),
        );
      } else pending.reject(failure("Invalid file transfer response", "provider", pending.machine));
      this.idle.push(worker);
      worker.unref();
    });
    worker.on("error", () => {
      if (this.workers.has(worker))
        void this.stop(worker, failure("File transfer worker failed", "unavailable"));
    });
    worker.on("exit", () => {
      if (this.workers.has(worker))
        void this.stop(worker, failure("File transfer worker exited", "unavailable"));
    });
    worker.unref();

    return worker;
  }

  private stop(worker: Worker, error: unknown): Promise<void> {
    const existing = this.stopping.get(worker);

    if (existing) return existing.promise;
    this.workers.delete(worker);
    this.idle = this.idle.filter((idle) => idle !== worker);
    const requests = [...this.pending].filter(([, request]) => request.worker === worker);

    for (const [id, request] of requests) {
      this.pending.delete(id);
      request.cleanup();
    }

    // Wait for termination before settling callers: this closes the worker's
    // fetch sockets and response bodies, rather than abandoning a raced promise.
    const stopping = worker.terminate().then(() => {
      for (const [, request] of requests) request.reject(error);
      this.stopping.delete(worker);
    });

    this.stopping.set(worker, { machine: requests[0]?.[1].machine, promise: stopping });

    return stopping;
  }

  private async transfer(input: Transfer): Promise<Result> {
    if (this.signal?.aborted) throw failure("File transfer aborted", "aborted", input.machine);

    if (this.moduleURL === undefined) this.moduleURL = webModuleURL() ?? null;

    if (this.moduleURL === null) return this.direct(input);
    // A worker owns exactly one active transfer. Its deadline cannot cancel a
    // concurrent request, even when the adapter manages several machines.
    const worker = this.start(this.moduleURL);
    worker.ref();
    const requestId = this.nextId++;

    return new Promise<Result>((resolve, reject) => {
      const abort = () => {
        void this.stop(worker, failure("File transfer aborted", "aborted", input.machine));
      };

      const timer = setTimeout(() => {
        void this.stop(
          worker,
          failure(
            "File transfer deadline exceeded; check the destination before retrying a write",
            "timeout",
            input.machine,
          ),
        );
      }, this.options.timeout ?? 30000);

      const cleanup = () => {
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", abort);
      };

      this.pending.set(requestId, { worker, machine: input.machine, resolve, reject, cleanup });
      this.signal?.addEventListener("abort", abort, { once: true });

      if (this.signal?.aborted) {
        abort();

        return;
      }

      try {
        worker.postMessage({ ...input, requestId });
      } catch {
        void this.stop(
          worker,
          failure("Could not submit file transfer", "unavailable", input.machine),
        );
      }
    });
  }

  /**
   * The bundled fallback: the SDK runs in this thread, so a deadline or abort settles the caller
   * but cannot cancel the request itself. Unary and download calls carry the SDK's own deadline;
   * a stalled streaming upload (over 3 MiB) is abandoned until its socket closes.
   */
  private async direct(input: Transfer): Promise<Result> {
    const client = await (this.inline ??= loadPeer(
      "@boxd-sh/sdk/web",
      "boxd",
      () => import("@boxd-sh/sdk/web"),
    ).then(({ Boxd }) => new Boxd(this.options)));

    const native =
      input.kind === "upload"
        ? client.machines.files.upload(input.machine, input.path, input.bytes)
        : client.machines.files.download(input.machine, input.path);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};

    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            failure(
              "File transfer deadline exceeded; check the destination before retrying a write",
              "timeout",
              input.machine,
            ),
          ),
        this.options.timeout ?? 30000,
      );
      abort = () => reject(failure("File transfer aborted", "aborted", input.machine));
      this.signal?.addEventListener("abort", abort, { once: true });

      // The signal may have fired while the client loaded.
      if (this.signal?.aborted) abort();
    });

    try {
      return await Promise.race([
        native.catch((error: unknown) => {
          throw boxdError(error, input.machine);
        }),
        stopped,
      ]);
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", abort);
    }
  }

  async upload(machine: string, path: string, bytes: Uint8Array): Promise<number> {
    const result = await this.transfer({ kind: "upload", machine, path, bytes });

    if (typeof result !== "number") throw failure("Invalid upload response", "provider", machine);

    return result;
  }
  async download(machine: string, path: string): Promise<Uint8Array> {
    const result = await this.transfer({ kind: "download", machine, path });

    if (!(result instanceof Uint8Array))
      throw failure("Invalid download response", "provider", machine);

    return result;
  }
  async closeMachine(machine: string) {
    const workers = new Set(
      [...this.pending.values()]
        .filter((request) => request.machine === machine)
        .map((request) => request.worker),
    );

    await Promise.all(
      [...workers].map((worker) =>
        this.stop(worker, failure("File transfers closed", "aborted", machine)),
      ),
    );
    await Promise.all(
      [...this.stopping.values()]
        .filter((request) => request.machine === machine)
        .map((request) => request.promise),
    );
  }
  async releaseIdle() {
    const workers = this.idle.splice(0);
    await Promise.all(
      workers.map((worker) =>
        this.stop(worker, failure("Idle file transfer worker closed", "aborted")),
      ),
    );
    await Promise.all([...this.stopping.values()].map((request) => request.promise));
  }
  async close() {
    await Promise.all(
      [...this.workers].map((worker) =>
        this.stop(worker, failure("File transfers closed", "aborted")),
      ),
    );
    await Promise.all([...this.stopping.values()].map((request) => request.promise));
  }
}

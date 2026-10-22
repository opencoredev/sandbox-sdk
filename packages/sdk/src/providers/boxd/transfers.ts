import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker, type MessagePort } from "node:worker_threads";
import type { BoxdOptions } from "@boxd-sh/sdk/web";
import { boxdError, failure } from "./errors.js";

type Transfer = { kind: "upload"; machine: string; path: string; bytes: Uint8Array } |
  { kind: "download"; machine: string; path: string };
type Result = number | Uint8Array;

// SDK 0.2.17's clientStream has neither a deadline nor a cancel handle, and
// close() is a no-op. Keep its fetches in an isolated realm we can terminate.
// Self-contained so the published bundle needs no separate worker artifact.
async function workerMain(
  port: MessagePort,
  data: { moduleURL: string; options: BoxdOptions },
  load: (url: string) => Promise<typeof import("@boxd-sh/sdk/web")>,
) {
  const { Boxd } = await load(data.moduleURL);
  const client = new Boxd(data.options);
  port.on("message", async (request: Transfer & { requestId: number }) => {
    try {
      const value = request.kind === "upload"
        ? await client.machines.files.upload(request.machine, request.path, request.bytes)
        : await client.machines.files.download(request.machine, request.path);
      port.postMessage({ requestId: request.requestId, value });
    } catch (error) {
      // Never send native messages, paths, credentials or stacks over IPC.
      port.postMessage({ requestId: request.requestId, error: {
        name: error instanceof Error ? error.name : "Error",
        grpcCode: typeof error === "object" && error !== null && "grpcCode" in error && typeof error.grpcCode === "number" ? error.grpcCode : undefined,
        permissionDenied: error instanceof Error && /permission denied/i.test(error.message),
      } });
    }
  });
}

export class FileTransfers {
  private workers = new Set<Worker>();
  private idle: Worker[] = [];
  private stopping = new Map<Worker, { machine?: string; promise: Promise<void> }>();
  private nextId = 0;
  private pending = new Map<number, {
    worker: Worker;
    machine: string;
    resolve(value: Result): void;
    reject(error: unknown): void;
    cleanup(): void;
  }>();
  constructor(private readonly options: BoxdOptions, private readonly signal?: AbortSignal) {}

  private start() {
    const idle = this.idle.pop();
    if (idle) return idle;
    // Dynamic import works in both CommonJS eval workers and parents launched
    // with --input-type=module, without discarding other inherited Node flags.
    const worker = new Worker(`import("node:worker_threads").then(({parentPort,workerData})=> (${workerMain.toString()})(parentPort,workerData,url=>import(url)))`, {
      eval: true,
      workerData: { moduleURL: pathToFileURL(createRequire(import.meta.url).resolve("@boxd-sh/sdk/web")).href, options: this.options },
    });
    this.workers.add(worker);
    worker.on("message", (reply: unknown) => {
      if (!this.workers.has(worker)) return;
      if (!reply || typeof reply !== "object" || !("requestId" in reply) || typeof reply.requestId !== "number") {
        void this.stop(worker, failure("Invalid file transfer response"));
        return;
      }
      const pending = this.pending.get(reply.requestId);
      if (!pending || pending.worker !== worker) return;
      this.pending.delete(reply.requestId);
      pending.cleanup();
      if ("value" in reply && (typeof reply.value === "number" || reply.value instanceof Uint8Array)) {
        pending.resolve(reply.value);
      } else if ("error" in reply && reply.error && typeof reply.error === "object") {
        const error = reply.error;
        pending.reject(boxdError(Object.assign(new Error("permissionDenied" in error && error.permissionDenied === true ? "permission denied" : "File transfer failed"), {
          name: "name" in error && typeof error.name === "string" ? error.name : "Error",
          grpcCode: "grpcCode" in error && typeof error.grpcCode === "number" ? error.grpcCode : undefined,
        }), pending.machine));
      } else pending.reject(failure("Invalid file transfer response", "provider", pending.machine));
      this.idle.push(worker);
      worker.unref();
    });
    worker.on("error", () => {
      if (this.workers.has(worker)) void this.stop(worker, failure("File transfer worker failed", "unavailable"));
    });
    worker.on("exit", () => {
      if (this.workers.has(worker)) void this.stop(worker, failure("File transfer worker exited", "unavailable"));
    });
    worker.unref();
    return worker;
  }

  private stop(worker: Worker, error: unknown): Promise<void> {
    const existing = this.stopping.get(worker);
    if (existing) return existing.promise;
    this.workers.delete(worker);
    this.idle = this.idle.filter(idle => idle !== worker);
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
    // A worker owns exactly one active transfer. Its deadline cannot cancel a
    // concurrent request, even when the adapter manages several machines.
    const worker = this.start();
    worker.ref();
    const requestId = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      const abort = () => { void this.stop(worker, failure("File transfer aborted", "aborted", input.machine)); };
      const timer = setTimeout(() => {
        void this.stop(worker, failure("File transfer deadline exceeded; check the destination before retrying a write", "timeout", input.machine));
      }, this.options.timeout ?? 30000);
      const cleanup = () => { clearTimeout(timer); this.signal?.removeEventListener("abort", abort); };
      this.pending.set(requestId, { worker, machine: input.machine, resolve, reject, cleanup });
      this.signal?.addEventListener("abort", abort, { once: true });
      if (this.signal?.aborted) { abort(); return; }
      try { worker.postMessage({ ...input, requestId }); }
      catch { void this.stop(worker, failure("Could not submit file transfer", "unavailable", input.machine)); }
    });
  }

  async upload(machine: string, path: string, bytes: Uint8Array): Promise<number> {
    const result = await this.transfer({ kind: "upload", machine, path, bytes });
    if (typeof result !== "number") throw failure("Invalid upload response", "provider", machine);
    return result;
  }
  async download(machine: string, path: string): Promise<Uint8Array> {
    const result = await this.transfer({ kind: "download", machine, path });
    if (!(result instanceof Uint8Array)) throw failure("Invalid download response", "provider", machine);
    return result;
  }
  async closeMachine(machine: string) {
    const workers = new Set([...this.pending.values()].filter(request => request.machine === machine).map(request => request.worker));
    await Promise.all([...workers].map(worker => this.stop(worker, failure("File transfers closed", "aborted", machine))));
    await Promise.all([...this.stopping.values()].filter(request => request.machine === machine).map(request => request.promise));
  }
  async releaseIdle() {
    const workers = this.idle.splice(0);
    await Promise.all(workers.map(worker => this.stop(worker, failure("Idle file transfer worker closed", "aborted"))));
    await Promise.all([...this.stopping.values()].map(request => request.promise));
  }
  async close() {
    await Promise.all([...this.workers].map(worker => this.stop(worker, failure("File transfers closed", "aborted"))));
    await Promise.all([...this.stopping.values()].map(request => request.promise));
  }
}

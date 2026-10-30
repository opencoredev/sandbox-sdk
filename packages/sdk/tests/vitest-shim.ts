import { isString } from "../src/shared/narrow.js";
// Stands in for the few vitest APIs the shared fakes call, so `scripts/consumer-smoke-nopeers.ts` can bundle
// the fakes (esbuild `alias: { vitest: this file }`) and run them in a plain Node or Bun consumer.
// `vi.importActual("@boxd-sh/sdk")` returns the local ExecStream below, so no provider SDK is bundled.

/** A push queue read as an async iterable, like the one behind @boxd-sh/sdk's ExecStream output. */
class ByteQueue {
  private buffer: Uint8Array[] = [];
  private waiting:
    | { resolve: (result: IteratorResult<Uint8Array>) => void; reject: (error: unknown) => void }
    | undefined;
  private closed = false;
  private error: unknown;
  push(chunk: Uint8Array) {
    if (this.closed) return;

    if (this.waiting) {
      const waiter = this.waiting;
      this.waiting = undefined;
      waiter.resolve({ value: chunk, done: false });

      return;
    }

    this.buffer.push(chunk);
  }
  close() {
    if (this.closed) return;
    this.closed = true;

    if (this.waiting) {
      const waiter = this.waiting;
      this.waiting = undefined;
      waiter.resolve({ value: undefined, done: true });
    }
  }
  fail(error: unknown) {
    if (this.closed) return;
    this.error = error;
    this.closed = true;

    if (this.waiting) {
      const waiter = this.waiting;
      this.waiting = undefined;
      waiter.reject(error);
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const next = this.buffer.shift();

        if (next) return Promise.resolve({ value: next, done: false });

        if (this.error !== undefined) return Promise.reject(this.error);

        if (this.closed) return Promise.resolve({ value: undefined, done: true });

        return new Promise((resolve, reject) => {
          this.waiting = { resolve, reject };
        });
      },
    };
  }
}

interface Transport {
  write(bytes: Uint8Array): void;
  end(): void;
  resize(cols: number, rows: number): void;
  cancel(): void;
}

/** The parts of @boxd-sh/sdk's ExecStream that `MockGuest` uses. */
class ExecStream {
  readonly stdout = new ByteQueue();
  readonly stderr = new ByteQueue();
  private exit: number | undefined;
  private failure: unknown;
  private done = false;
  private waiters: { resolve: (code: number) => void; reject: (error: unknown) => void }[] = [];
  constructor(private readonly transport: Transport) {}
  write(data: string | Uint8Array) {
    this.transport.write(isString(data) ? new TextEncoder().encode(data) : data);
  }
  end() {
    this.transport.end();
  }
  resize(cols: number, rows: number) {
    this.transport.resize(cols, rows);
  }
  get exitCode() {
    return this.exit;
  }
  wait(): Promise<number> {
    if (this.done)
      return this.failure === undefined
        ? Promise.resolve(this.exit ?? -1)
        : Promise.reject(this.failure);

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
  close() {
    this.transport.cancel();
  }
  _setExit(code: number) {
    if (this.done) return;
    this.exit = code;
    this.done = true;

    for (const waiter of this.waiters.splice(0)) waiter.resolve(code);
  }
  _setError(error: unknown) {
    if (this.done) return;
    this.failure = error;
    this.done = true;

    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

const afterAllHooks: (() => unknown)[] = [];

/** Collected, not run: call {@link runAfterAll} when the consumer is done with the fakes. */
export function afterAll(hook: () => unknown) {
  afterAllHooks.push(hook);
}

export async function runAfterAll() {
  for (const hook of afterAllHooks.splice(0)) await hook();
}

export const vi = {
  stubGlobal(name: string, value: unknown) {
    Reflect.set(globalThis, name, value);
  },
  async importActual(name: string): Promise<{ ExecStream: typeof ExecStream }> {
    if (name !== "@boxd-sh/sdk") throw new Error(`The vitest shim cannot import ${name}`);

    return { ExecStream };
  },
};

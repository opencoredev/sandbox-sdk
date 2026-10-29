import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { FileTransfers } from "../src/providers/boxd/transfers.js";

// Real pinned SDK, real fetch/socket/body. Only the remote grpc-web server is a
// local fixture. Stalling after headers catches deadlines that only cover fetch().
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
function frame(payload: Uint8Array) {
  const result = Buffer.alloc(5 + payload.length);
  result.writeUInt32BE(payload.length, 1);
  result.set(payload, 5);
  return result;
}
async function fixture(stall: "headers" | "body" | "auth" | "none" | "missing" | "nofile") {
  let behavior = stall;
  let responseDelay = 0;
  let arrived = () => {};
  let disconnected = () => {};
  const started = new Promise<void>(resolve => { arrived = resolve; });
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const paths: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    paths.push(req.url ?? "");
    const auth = req.url?.includes("/auth/");
    if (auth && behavior !== "auth") {
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ token: "local-fixture-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
      return;
    }
    arrived();
    res.on("close", disconnected);
    req.resume();
    if (behavior === "body") {
      res.writeHead(200, { "content-type": "application/grpc-web+proto" });
      res.write(Buffer.from([0]));
    } else if (behavior === "missing") {
      res.writeHead(200, { "grpc-status": "5", "grpc-message": "private-native-detail" });
      res.end();
    } else if (behavior === "nofile") {
      // boxd's wording for a missing guest path; a missing VM is "VM not found".
      res.writeHead(200, { "grpc-status": "5", "grpc-message": encodeURIComponent("no such file on sbxsdk-private: /workspace/private.txt") });
      res.end();
    } else if (behavior === "none") {
      res.writeHead(200, { "content-type": "application/grpc-web+proto", "grpc-status": "0" });
      // UploadFileResponse.bytesWritten=4MiB (field 1). DownloadFileChunk
      // totalSize=3 (field 1), data=[0,255,42] (field 2).
      const payload = req.url?.endsWith("DownloadFileStream")
        ? Buffer.from([8, 3, 18, 3, 0, 255, 42])
        : Buffer.from([8, 128, 128, 128, 2]);
      if (responseDelay) setTimeout(() => res.end(frame(payload)), responseDelay);
      else res.end(frame(payload));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { baseURL: `http://127.0.0.1:${address.port}`, started, closed, paths, succeed(delay = 0) { behavior = "none"; responseDelay = delay; } };
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture did not observe cancellation")), 2000); })]); }
  finally { clearTimeout(timer); }
}
function transfers(baseURL: string, signal?: AbortSignal, timeout = 500) {
  const client = new FileTransfers({ apiKey: "local-fixture-key", baseURL, timeout, maxRetries: 0 }, signal);
  cleanup.push(() => client.close());
  return client;
}

for (const kind of ["upload", "download"] as const) {
  for (const stall of ["headers", "body", "auth"] as const) {
    test(`${kind} deadline terminates stalled ${stall} and closes the underlying socket`, async () => {
      const server = await fixture(stall);
      const client = transfers(server.baseURL);
      const pending = kind === "upload" ? client.upload("machine", "/file", new Uint8Array(4 * 1024 * 1024)) : client.download("machine", "/file");
      await expect(deadline<unknown>(pending)).rejects.toMatchObject({ code: "timeout" });
      await deadline(server.closed);
      if (stall !== "auth") expect(server.paths.some(path => path.endsWith(kind === "upload" ? "UploadFileStream" : "DownloadFileStream"))).toBe(true);
    }, 5000);
  }
  test(`${kind} caller cancellation closes the socket before returning`, async () => {
    const server = await fixture("body");
    const controller = new AbortController();
    const client = transfers(server.baseURL, controller.signal, 10000);
    const pending = kind === "upload" ? client.upload("machine", "/file", new Uint8Array(4 * 1024 * 1024)) : client.download("machine", "/file");
    const result = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await deadline(server.started);
    controller.abort();
    await result;
    await deadline(server.closed);
  }, 5000);
}

test("already-aborted cancellation sends no request", async () => {
  const server = await fixture("none");
  const controller = new AbortController(); controller.abort();
  const client = transfers(server.baseURL, controller.signal);
  await expect(client.upload("machine", "/file", new Uint8Array(4 * 1024 * 1024))).rejects.toMatchObject({ code: "aborted" });
  await expect(client.download("machine", "/file")).rejects.toMatchObject({ code: "aborted" });
  expect(server.paths).toEqual([]);
});

test("successful streaming upload and binary download leave the client reusable", async () => {
  const server = await fixture("none");
  const client = transfers(server.baseURL, undefined, 2000);
  expect(await client.upload("machine", "/file", new Uint8Array(4 * 1024 * 1024))).toBe(4 * 1024 * 1024);
  expect(await client.download("machine", "/file")).toEqual(new Uint8Array([0, 255, 42]));
  expect(server.paths.filter(path => path.includes("/auth/"))).toHaveLength(1);
});


test("a timed-out worker is replaced without replaying its upload", async () => {
  const server = await fixture("body");
  const client = transfers(server.baseURL);
  await expect(client.upload("machine", "/file", new Uint8Array(4 * 1024 * 1024))).rejects.toMatchObject({ code: "timeout" });
  await deadline(server.closed);
  server.succeed();
  expect(await client.upload("machine", "/file", new Uint8Array(4 * 1024 * 1024))).toBe(4 * 1024 * 1024);
  expect(server.paths.filter(path => path.endsWith("UploadFileStream"))).toHaveLength(2);
});

test("closing the transport cancels pending transfers and closes their sockets", async () => {
  const server = await fixture("body");
  const client = transfers(server.baseURL, undefined, 10000);
  const pending = client.download("machine", "/file");
  const result = pending.then(() => "success", error => error.code);
  await deadline(server.started);
  await client.close();
  expect(await result).toBe("aborted");
  await deadline(server.closed);
});

test("one machine's stalled transfer cannot cancel another machine's request", async () => {
  const server = await fixture("body");
  const client = transfers(server.baseURL, undefined, 1000);
  const first = client.download("machine-a", "/file").then(() => undefined, error => error);
  await deadline(server.started);
  // Start the second request near the first request's deadline, while its own
  // 1-second budget still has ample time left for a successful response.
  await new Promise(resolve => setTimeout(resolve, 700));
  server.succeed(400);
  const second = client.download("machine-b", "/file");
  expect(await second).toEqual(new Uint8Array([0, 255, 42]));
  expect(await first).toMatchObject({ code: "timeout", sandboxId: "machine-a" });
});


test("releasing idle workers leaves active transfers running", async () => {
  const server = await fixture("none");
  const client = transfers(server.baseURL, undefined, 2000);
  await client.download("machine-a", "/file");
  server.succeed(300);
  const pending = client.download("machine-b", "/file");
  await new Promise(resolve => setTimeout(resolve, 30));
  await client.releaseIdle();
  await client.closeMachine("machine-a");
  expect(await pending).toEqual(new Uint8Array([0, 255, 42]));
});

test("lifecycle cleanup waits for a cancellation already terminating its worker", async () => {
  const server = await fixture("body");
  const controller = new AbortController();
  const client = transfers(server.baseURL, controller.signal, 10000);
  const pending = client.download("machine-a", "/file");
  const result = expect(pending).rejects.toMatchObject({ code: "aborted" });
  await deadline(server.started);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const terminate = Worker.prototype.terminate;
  const spy = vi.spyOn(Worker.prototype, "terminate").mockImplementation(async function (this: Worker) {
    await gate;
    return terminate.call(this);
  });
  try {
    controller.abort();
    let machineClosed = false;
    let idleReleased = false;
    const closing = client.closeMachine("machine-a").then(() => { machineClosed = true; });
    const releasing = client.releaseIdle().then(() => { idleReleased = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(machineClosed).toBe(false);
    expect(idleReleased).toBe(false);
    release();
    await Promise.all([closing, releasing, result]);
    await deadline(server.closed);
  } finally {
    release();
    spy.mockRestore();
  }
});

for (const kind of ["upload", "download"] as const) {
  test(`${kind} preserves machine identity when translating SDK errors`, async () => {
    const server = await fixture("missing");
    const client = transfers(server.baseURL);
    const pending = kind === "upload" ? client.upload("machine-id", "/file", new Uint8Array(4 * 1024 * 1024)) : client.download("machine-id", "/file");
    await expect(pending).rejects.toMatchObject({ code: "not_found", sandboxId: "machine-id" });
    // The worker sends only the error name and gRPC code, so the cause holds nothing else.
    await expect(pending).rejects.toHaveProperty("cause", expect.stringMatching(/^\w+ gRPC \d+$/));
  });
}

for (const kind of ["upload", "download"] as const) {
  test(`${kind} of a missing guest path is file_not_found without its path`, async () => {
    const server = await fixture("nofile");
    const client = transfers(server.baseURL);
    const pending = kind === "upload" ? client.upload("machine-id", "/file", new Uint8Array(4)) : client.download("machine-id", "/file");
    await expect(pending).rejects.toMatchObject({ code: "file_not_found", sandboxId: "machine-id" });
    await expect(pending).rejects.not.toHaveProperty("cause", expect.stringContaining("private"));
  });
}

test("with no SDK file on disk for a worker, as in a bundle, transfers run in this thread", async () => {
  const server = await fixture("none");
  const client = transfers(server.baseURL, undefined, 2000);
  // What webModuleURL() finds when import.meta.url is empty and the app directory has no node_modules.
  Reflect.set(client, "moduleURL", null);
  const workers = vi.spyOn(Worker.prototype, "postMessage");
  expect(await client.upload("machine", "/file", new Uint8Array(4 * 1024 * 1024))).toBe(4 * 1024 * 1024);
  expect(await client.download("machine", "/file")).toEqual(new Uint8Array([0, 255, 42]));
  expect(workers).not.toHaveBeenCalled();
  workers.mockRestore();
  const missing = await fixture("nofile");
  const direct = transfers(missing.baseURL);
  Reflect.set(direct, "moduleURL", null);
  await expect(direct.download("machine-id", "/file")).rejects.toMatchObject({ code: "file_not_found", sandboxId: "machine-id" });
});

test("in this thread, a stalled transfer still settles the caller at its deadline and on abort", async () => {
  const server = await fixture("body");
  const client = transfers(server.baseURL, undefined, 300);
  Reflect.set(client, "moduleURL", null);
  await expect(deadline<unknown>(client.download("machine", "/file"))).rejects.toMatchObject({ code: "timeout", sandboxId: "machine" });
  const controller = new AbortController();
  const aborting = transfers(server.baseURL, controller.signal, 10_000);
  Reflect.set(aborting, "moduleURL", null);
  const pending = aborting.download("machine", "/file");
  const result = expect(pending).rejects.toMatchObject({ code: "aborted" });
  await deadline(server.started);
  controller.abort();
  await result;
});

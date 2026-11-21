// The Docker Engine client's timeouts, against a fake Engine on a unix socket.
import { ClientRequest, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Docker } from "../src/providers/local/docker.js";
import { local } from "../src/providers/local/index.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** One stdout frame of Docker's multiplexed exec stream. */
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);

  return Buffer.concat([header, body]);
}

async function fakeEngine(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const dir = await mkdtemp(join(tmpdir(), "sandbox-sdk-docker-"));
  const socket = join(dir, "docker.sock");
  const server = createServer(handle);
  await new Promise<void>((done) => server.listen(socket, done));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });

  return `unix://${socket}`;
}

test("an exec attached without an upgrade may stay silent past the attach timeout", async () => {
  // Rescale any large nonzero ClientRequest timeout (such as main's 30 s default) to 100 ms so a
  // missing clear-timeout on the plain-200 response path fails this test within 400 ms.
  const originalSetTimeout = ClientRequest.prototype.setTimeout;
  ClientRequest.prototype.setTimeout = function (
    this: ClientRequest,
    msecs: number,
    callback?: () => void,
  ) {
    const scaled = msecs >= 1_000 ? 100 : msecs;

    return callback
      ? originalSetTimeout.call(this, scaled, callback)
      : originalSetTimeout.call(this, scaled);
  };

  cleanup.push(async () => {
    ClientRequest.prototype.setTimeout = originalSetTimeout;
  });

  const host = await fakeEngine((req, res) => {
    if (req.url?.endsWith("/containers/box/exec")) return res.end(JSON.stringify({ Id: "exec-1" }));

    if (req.url?.endsWith("/exec/exec-1/json"))
      return res.end(JSON.stringify({ Running: false, ExitCode: 0 }));

    // This Engine answers the attach with a plain 200 stream, then goes quiet for a while.
    res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
    res.flushHeaders();
    setTimeout(() => res.end(frame("done\n")), 400);
  });

  const docker = new Docker(host, { attachTimeoutMs: 100 });
  let output = "";

  const exitCode = await docker.exec("box", ["sh", "-c", "sleep 1; echo done"], {
    onChunk: (chunk) => (output += chunk.text),
  });

  expect(exitCode).toBe(0);
  expect(output).toBe("done\n");
});

test("an attach that never starts streaming is a timeout, reported once", async () => {
  const host = await fakeEngine((req, res) => {
    if (req.url?.endsWith("/containers/box/exec")) return res.end(JSON.stringify({ Id: "exec-1" }));
    // The attach is never answered.
  });

  const attach = new Docker(host, { attachTimeoutMs: 100 }).exec("box", ["true"], {
    onChunk: () => {},
  });

  await expect(attach).rejects.toMatchObject({
    code: "timeout",
    message: expect.not.stringMatching(/Docker request failed.*Docker request failed/),
  });
});

test("apiTimeoutMs bounds a Docker API call and is validated", async () => {
  const host = await fakeEngine((_req, res) => {
    setTimeout(() => res.end("{}"), 2_000);
  });

  await expect(
    new Docker(host, { apiTimeoutMs: 100 }).call("GET", "/containers/box/json"),
  ).rejects.toMatchObject({
    code: "timeout",
    message: expect.stringContaining("Docker API timed out"),
  });

  expect(() => local({ dockerHost: host, apiTimeoutMs: 0 })).toThrowError(
    expect.objectContaining({ code: "invalid_argument" }),
  );
  expect(() => local({ dockerHost: host, apiTimeoutMs: 2_147_483_648 })).toThrowError(
    expect.objectContaining({ code: "invalid_argument" }),
  );
});

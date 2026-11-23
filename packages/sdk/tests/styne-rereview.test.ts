/**
 * Regressions from the second independent review of the Styne adapter (74b807e): a cancel that cannot
 * confirm the group died, exec lines and answers the adapter must not trust, a snapshot answer naming
 * another snapshot, an envd token seen through `box.native`, and an unreadable connect answer.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import { connectSandbox } from "../src/index.js";
import { styne } from "../src/providers/styne/index.js";
import type { JsonObject } from "../src/shared/json.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

const id = "vmReview123";
const execRoute = "POST /sandboxes/{id}/exec";
const killRoute = "POST /sandboxes/{id}/commands";
const snapshotRoute = "POST /sandboxes/{id}/snapshots";
const fixture = { sandboxID: id, domain: "ash.styne.ai", state: "paused" };
const fixtureKey = "review-fixture-api-key";
const frame = (value: JsonObject) => JSON.stringify(value) + "\n";
const cleanKill = { json: { exitCode: 0, signal: 0, timedOut: false } };
let server: FakeServer;

beforeEach(async () => {
  server = await fakeServer();
  server.on("GET /sandboxes/{id}", { json: fixture });
});

afterEach(async () => server.close());

const provider = () => styne({ apiKey: fixtureKey, baseUrl: server.url });
const attached = () => connectSandbox(provider(), id, { recoverSecrets: false });

type Outcome = { kind: "success"; value: unknown } | { kind: "error"; code: unknown };

async function result(task: PromiseLike<unknown>): Promise<Outcome> {
  return Promise.resolve(task).then(
    (value) => ({ kind: "success", value }),
    (error: Error) => ({
      kind: "error",
      code: error instanceof SandboxError ? error.code : undefined,
    }),
  );
}

test("guest kill failures cannot confirm cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-styne-kill-"));
  const execDir = join(root, "exec");
  await mkdir(execDir);
  const guest = spawn("/bin/sleep", ["5"], { detached: true });
  const pid = guest.pid;

  if (pid === undefined) throw new Error("failed to start bounded local fixture");
  let markStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const records: (number | null)[] = [];

  try {
    server.on(execRoute, async (request, response) => {
      const { argv } = JSON.parse(request.body.toString().split("\n")[0] ?? "");
      await writeFile(join(execDir, argv.at(-1)), String(pid) + "\n");
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write(frame({ started: { pid } }));
      markStarted();
    });
    // Runs the adapter's real kill script here, against the local process, with every kill failing.
    server.on(killRoute, (request, response) => {
      const { argv } = JSON.parse(request.body.toString());
      const [command, flag, script, ...args] = argv;

      const commandResult = spawnSync(
        command,
        [
          flag,
          "kill() { return 1; }\n" + script.replaceAll("/tmp/.sandbox-sdk/exec", execDir),
          ...args,
        ],
        { timeout: 1000, encoding: "utf8" },
      );

      records.push(commandResult.status);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ exitCode: commandResult.status, signal: 0, timedOut: false }));
    });

    const box = await attached();
    const abort = new AbortController();
    const pending = result(box.run("true", { cwd: "/", signal: abort.signal }));
    await started;
    abort.abort();
    const outcome = await pending;
    let guestStillRunning: boolean;

    try {
      process.kill(pid, 0);
      guestStillRunning = true;
    } catch {
      guestStillRunning = false;
    }

    expect({
      killExit: records.at(-1),
      guestStillRunning,
      result: outcome.kind === "error" ? outcome.code : "success",
    }).toEqual({
      killExit: expect.any(Number),
      guestStillRunning: true,
      result: "outcome_unknown",
    });
    expect(records.every((status) => status !== 0)).toBe(true);
  } finally {
    guest.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([{ stdout: 92 }, { stdout: "!!!!" }, { stderr: "a" }])(
  "invalid output frame %j cannot become a successful run",
  async (malformed) => {
    server.on(execRoute, {
      stream: [
        frame({ started: { pid: 42 } }),
        frame(malformed),
        frame({ exit: { exitCode: 0, signal: 0, timedOut: false } }),
      ],
    });
    server.on(killRoute, cleanKill);
    const box = await attached();
    const outcome = await result(box.run("true"));
    expect({ ...outcome, kills: server.calls(killRoute).length }).toMatchObject({
      kind: "error",
      code: "outcome_unknown",
      kills: 1,
    });
  },
);

test("unpadded base64 output still reads", async () => {
  server.on(execRoute, {
    stream: [
      frame({ started: { pid: 42 } }),
      frame({ stdout: "aGk" }),
      frame({ exit: { exitCode: 0, signal: 0, timedOut: false } }),
    ],
  });
  const box = await attached();
  const run = await box.run("true");
  expect({ stdout: run.stdout, exitCode: run.exitCode }).toEqual({ stdout: "hi", exitCode: 0 });
});

test("a 204 exec response starts cancellation before returning outcome_unknown", async () => {
  server.on(execRoute, { status: 204 });
  server.on(killRoute, cleanKill);
  const box = await attached();
  const outcome = await result(box.run("true"));
  expect({ ...outcome, kills: server.calls(killRoute).length }).toEqual({
    kind: "error",
    code: "outcome_unknown",
    kills: 1,
  });
});

test("malformed connect success reports that a resume may have occurred", async () => {
  server.on("POST /sandboxes/{id}/connect", { status: 201, body: "{" });
  const box = await attached();
  expect(await result(box.preview(3000))).toEqual({ kind: "error", code: "outcome_unknown" });
});

test("a snapshot response with a wrong name looks up the requested snapshot", async () => {
  let requested = "";

  server.on(snapshotRoute, (request, response) => {
    requested = JSON.parse(request.body.toString()).name;
    response
      .writeHead(201, { "content-type": "application/json" })
      .end(JSON.stringify({ name: "operator-copy", sandboxID: id }));
  });
  server.on("GET /snapshots/{name}", (request, response) => {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ name: request.url.split("/").at(-1), sandboxID: id }));
  });
  const box = await attached();
  const saved = await box.snapshot();
  expect({
    id: saved.id,
    lookups: server.calls("GET /snapshots/{name}").map((r) => r.url),
  }).toEqual({ id: requested, lookups: ["/snapshots/" + requested] });
});

test("later native errors redact an envd credential from a native sandbox response", async () => {
  const envd = "localfixtureabcdef0123456789qxyz";

  server.on("POST /sandboxes/{id}/connect", {
    status: 201,
    json: { ...fixture, envdAccessToken: envd },
  });
  server.on("GET /sandboxes/{id}/command-history", {
    status: 500,
    json: { error_code: "internal", message: "request failed while using " + envd },
  });
  const box = await attached();

  const info = await box.native.request<{ envdAccessToken: string }>(
    "POST",
    "/sandboxes/{id}/connect",
    { body: {} },
  );

  expect(info.envdAccessToken === envd).toBe(true);

  const error = await box.native
    .request("GET", "/sandboxes/{id}/command-history")
    .catch((issue: Error) => issue);

  expect(String(error).includes(envd)).toBe(false);
});

test("provider.api redacts a traffic token listed in a nested answer", async () => {
  const traffic = "localtrafficabcdef0123456789qxyz";

  server.on("GET /sandboxes", { json: [{ ...fixture, trafficAccessToken: traffic }] });
  server.on("GET /snapshots", {
    status: 500,
    json: { error_code: "internal", message: "listing failed near " + traffic },
  });
  const api = provider().api;
  await api.request("GET", "/sandboxes");
  const error = await api.request("GET", "/snapshots").catch((issue: Error) => issue);
  expect(String(error).includes(traffic)).toBe(false);
});

/** The adapter's kill script, as a cancel sends it, with the PID it was given. */
async function killScript(startedPid: number) {
  let argv: string[] = [];

  server.on(execRoute, (_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(frame({ started: { pid: startedPid } }));
  });
  server.on(killRoute, (request, response) => {
    argv = JSON.parse(request.body.toString()).argv;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(cleanKill.json));
  });
  const box = await attached();
  await box.run("true", { timeoutMs: 50 });
  const [command, flag, script, ...args] = argv;

  if (command !== "sh" || flag !== "-c" || script === undefined) throw new Error("no kill command");
  // Every kill below is the shell function; a script that reached the real one could signal this host.
  expect(/command\s+kill|\/kill\b|builtin/.test(script)).toBe(false);

  return { script, args };
}

/**
 * Runs the kill script in a scratch exec dir with `kill` shadowed by `fake`, a shell function body that
 * sees the arguments and logs every call. No signal is ever sent.
 */
async function runKiller(input: { pid: string; record?: string; fake: string }) {
  const { script, args } = await killScript(42);
  const root = await mkdtemp(join(tmpdir(), "review-styne-killer-"));

  try {
    const [tag] = args;

    if (input.record !== undefined) await writeFile(join(root, String(tag)), input.record + "\n");
    const log = join(root, "kills.log");
    const shadow = `kill() { echo "$*" >> '${log}'; ${input.fake}\n}\n`;

    const run = spawnSync(
      "sh",
      [
        "-c",
        shadow + script.replaceAll("/tmp/.sandbox-sdk/exec", root),
        "sandbox-sdk",
        String(tag),
        input.pid,
      ],
      { timeout: 5000, encoding: "utf8" },
    );

    const calls = await readFile(log, "utf8").catch(() => "");

    return { status: run.status, calls: calls.split("\n").filter(Boolean) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.each(["1", "0", "01", "-1", "1 2", "x"])(
  "the kill script refuses PID %j without sending any signal",
  async (pid) => {
    expect(await runKiller({ pid, fake: "return 0" })).toEqual({ status: 1, calls: [] });
  },
);

test("the kill script refuses a recorded PID of 1", async () => {
  expect(await runKiller({ pid: "", record: "1", fake: "return 0" })).toEqual({
    status: 1,
    calls: [],
  });
});

test("the kill script exits 0 once the group and the PID are both gone", async () => {
  const fake = `[ "$1" = -0 ] && { echo "kill: No such process" >&2; return 1; }; return 0`;

  expect(await runKiller({ pid: "4242", fake })).toEqual({
    status: 0,
    calls: ["-KILL -4242", "-0 -4242", "-0 4242"],
  });
});

test("the kill script waits for a killed group to be reaped, then gives up", async () => {
  // kill -0 keeps succeeding, as for a process that is dead but not yet reaped.
  const { status, calls } = await runKiller({ pid: "4242", fake: "return 0" });

  expect({ status, kills: calls.filter((call) => call === "-KILL -4242").length }).toEqual({
    status: 1,
    kills: 41,
  });
});

test("a kill that fails for another reason exits 1 at once", async () => {
  const fake = `[ "$1" = -0 ] && { echo "kill: Operation not permitted" >&2; return 1; }; return 0`;

  expect(await runKiller({ pid: "4242", fake })).toEqual({
    status: 1,
    calls: ["-KILL -4242", "-0 -4242"],
  });
});

test("box.native.request handles large JSON arrays without overflowing the call stack", async () => {
  const large = Array.from({ length: 160_000 }, (_, i) => i);

  server.on("GET /sandboxes/{id}/large", { json: large });
  const box = await attached();
  const data = await box.native.request<number[]>("GET", `/sandboxes/${id}/large`);

  expect(data).toHaveLength(160_000);
  expect(data[159_999]).toBe(159_999);
});

test("the kill script creates a missing exec directory before writing the cancel marker", async () => {
  const { script, args } = await killScript(42);
  const root = await mkdtemp(join(tmpdir(), "review-styne-missing-dir-"));

  try {
    const missing = join(root, "nested", "exec");
    const [tag] = args;

    const run = spawnSync(
      "sh",
      ["-c", script.replaceAll("/tmp/.sandbox-sdk/exec", missing), "sandbox-sdk", String(tag), ""],
      { timeout: 5000, encoding: "utf8" },
    );

    expect(run.status).toBe(0);
    expect(await readFile(join(missing, `${String(tag)}.cancel`), "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

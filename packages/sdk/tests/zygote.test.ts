// The guest zygote (SBX-78): Freestyle and Superserve fork each command's supervisor from a warm
// interpreter. These drive the real client, zygote and Freestyle supervisor on Linux. Native exec
// hands the client pipes, so the harness does too; the provider fakes hand it sockets, which the
// zygote refuses, so provider tests cover the fallback.
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zygoteSupervisor } from "../src/shared/guest.js";
import { supervisor } from "../src/providers/freestyle/execute.js";
import { guestSpec } from "../src/shared/wire.js";
import { isNumber, isObject } from "../src/shared/narrow.js";

// A replaced zygote takes up to its 5 s check to stop.
vi.setConfig({ testTimeout: 30000 });

let base = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "sdk-zygote-"));
});

// Removing the directory also stops the zygotes these tests started.
afterAll(() => rm(base, { recursive: true, force: true }));

const launch = zygoteSupervisor(supervisor);

// The supervisor's last argument: the zygote directory when a zygote child ran the request,
// the run directory when the client ran the supervisor itself.
const parent = "tr '\\0' '\\n' </proc/$PPID/cmdline | tail -1 | sed 's|.*/||' | cut -c1-2";

interface Outcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

interface Request {
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Hand the client socket stdio, as Node's spawn does, instead of pipes. */
  sockets?: boolean;
}

function isRecord(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    (value[0] === "stdout" || value[0] === "stderr") &&
    typeof value[1] === "string"
  );
}

async function request(command: string, options: Request = {}): Promise<Outcome> {
  const guest = join(base, "tmp/.sandbox-sdk");
  const root = `/tmp/.sandbox-sdk/run-${crypto.randomUUID()}`;
  const id = crypto.randomUUID();

  const script = join(base, `${id}.sh`),
    input = join(base, `${id}.hex`),
    errors = join(base, `${id}.err`);

  await writeFile(script, launch.zygote(root).replaceAll("/tmp/.sandbox-sdk", guest));
  await writeFile(
    input,
    guestSpec({
      command,
      cwd: options.cwd ?? base,
      env: { TOKEN: "secret-$-1" },
      stdin: options.stdin ?? "",
      timeoutMs: options.timeoutMs ?? 10000,
    }).toString("hex"),
  );

  const { stdout, status } = await new Promise<{ stdout: string; status: number | null }>(
    (resolve, reject) => {
      // A shell pipeline gives the client pipes; spawn's own stdio are sockets.
      const child = options.sockets
        ? spawn("sh", [script], { stdio: ["pipe", "pipe", "ignore"] })
        : spawn("sh", ["-c", 'cat "$1" | sh "$2" 2>"$3" | cat', "sh", input, script, errors]);

      if (options.sockets) readFile(input).then((bytes) => child.stdin?.end(bytes), reject);
      let text = "";
      child.stdout?.on("data", (bytes: Buffer) => (text += bytes.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ stdout: text, status: code }));
    },
  );

  const page: unknown = JSON.parse(stdout);

  if (
    !isObject(page) ||
    !("result" in page) ||
    !isObject(page.result) ||
    !("chunks" in page) ||
    !Array.isArray(page.chunks) ||
    !("offset" in page) ||
    !isNumber(page.offset)
  )
    throw new Error(`Invalid page: ${stdout}`);

  const exitCode =
    "exitCode" in page.result && isNumber(page.result.exitCode) ? page.result.exitCode : null;

  const timedOut = "timedOut" in page.result && page.result.timedOut === true;
  // Records past the inline page stay in the spool, where the SDK's ranged reads find them.
  const offset = page.offset;

  const rest = await readFile(join(guest, root.slice("/tmp/.sandbox-sdk/".length), "out")).then(
    (bytes) => bytes.subarray(offset).toString(),
    () => "",
  );

  const records: unknown[] = [
    ...page.chunks,
    ...rest
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  ];

  const output = { stdout: "", stderr: "" };

  for (const record of records) {
    if (!isRecord(record)) throw new Error("Invalid record");
    output[record[0] === "stdout" ? "stdout" : "stderr"] += Buffer.from(
      record[1],
      "hex",
    ).toString();
  }

  return { exitCode, timedOut, status, ...output };
}

async function zygotePid(not?: number) {
  const guest = join(base, "tmp/.sandbox-sdk");

  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      const name = (await readdir(guest)).find((entry) => entry.startsWith("z-"));

      const pid = name
        ? Number((await readFile(join(guest, name, "pid"), "utf8")).split(" ")[0])
        : 0;

      if (name && pid && pid !== not) return { pid, dir: join(guest, name) };
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("The zygote did not start");
}

async function exited(pid: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("The zygote did not stop");
}

function shell(command: string) {
  return new Promise<string>((resolve, reject) =>
    execFile("sh", ["-c", command], { timeout: 5000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );
}

test("the first requests run in the client; later ones run through the zygote with the same results", async () => {
  expect((await request(parent)).stdout).toBe("ru\n");
  // A sandbox that runs one command never starts a zygote; the second one-shot starts it.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect(readdir(join(base, "tmp/.sandbox-sdk"))).resolves.not.toContainEqual(
    expect.stringMatching(/^z-[0-9a-f]+$/),
  );
  expect((await request(parent)).stdout).toBe("ru\n");
  await zygotePid();
  expect((await request(parent)).stdout).toBe("z-\n");

  const result = await request('echo out; echo err >&2; cat; printf " %s" "$TOKEN"; exit 3', {
    stdin: "in-雪",
  });

  expect(result).toMatchObject({
    status: 0,
    exitCode: 3,
    timedOut: false,
    stdout: "out\nin-雪 secret-$-1",
    stderr: "err\n",
  });
  expect((await request("kill -TERM $$")).exitCode).toBe(143);
  expect((await request("head -c 300000 /dev/zero | tr '\\0' x")).stdout.length).toBe(300000);
});

test("a timeout under the zygote kills the whole process tree", async () => {
  await zygotePid();
  const marker = `${Date.now() % 100000}`;

  const result = await request(
    `${parent} >&2; sleep 31.${marker} & sleep 31.${marker}; echo never`,
    { timeoutMs: 1000 },
  );

  expect(result).toMatchObject({ timedOut: true, exitCode: null, stdout: "", stderr: "z-\n" });
  // The bracket keeps pgrep from matching its own shell.
  expect((await shell(`pgrep -f 'sleep [3]1.${marker}' || echo none`)).trim()).toBe("none");
});

test("a missing cwd still exits 2 with the cd error under the zygote", async () => {
  await zygotePid();
  const result = await request(`${parent} >&2; pwd`, { cwd: join(base, "does-not-exist") });
  expect(result).toMatchObject({ exitCode: 2, timedOut: false, stdout: "" });
  expect(result.stderr).toMatch(/cd.*does-not-exist/);
});

test("concurrent requests each get their own output through one zygote", async () => {
  await zygotePid();

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      request(`echo n${i}; echo e${i} >&2; ${parent}; exit ${i}`),
    ),
  );

  results.forEach((result, i) =>
    expect(result).toMatchObject({ stdout: `n${i}\nz-\n`, stderr: `e${i}\n`, exitCode: i }),
  );
});

test("a dead zygote is detected, the request runs in the client and a new zygote starts", async () => {
  const { pid } = await zygotePid();
  process.kill(pid, "SIGKILL");
  expect((await request(`echo back; ${parent}`)).stdout).toBe("back\nru\n");
  await zygotePid(pid);
  expect((await request(parent)).stdout).toBe("z-\n");
});

test("a zygote record from another boot is ignored", async () => {
  const { pid, dir } = await zygotePid();
  await writeFile(join(dir, "pid"), `${pid} 00000000-0000-0000-0000-000000000000\n`);
  expect((await request(`echo ok; ${parent}`)).stdout).toBe("ok\nru\n");
  // The replaced zygote stops at its next 5 s check and frees the lock for a new one.
  await exited(pid);
  await request("true");
  await zygotePid(pid);
});

test("a stalled zygote cannot hold a request, and stops being used", async () => {
  const { pid, dir } = await zygotePid();
  process.kill(pid, "SIGSTOP");

  try {
    const started = Date.now();
    // Unclaimed requests go back to the client after 3 s from a live but stalled zygote.
    expect((await request(`echo ok; ${parent}`)).stdout).toBe("ok\nru\n");
    expect(Date.now() - started).toBeLessThan(15000);
    expect(await readFile(join(dir, "pid"), "utf8")).toBe("");
    expect((await request(`echo again; ${parent}`)).stdout).toBe("again\nru\n");
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

test("a client whose stdio are sockets gets its request back and the zygote is switched off", async () => {
  await request("true");
  const { dir } = await zygotePid();
  expect((await request(`echo ok; ${parent}`, { sockets: true })).stdout).toBe("ok\nru\n");
  await expect(readFile(join(dir, "off"), "utf8")).resolves.toBe("");
  expect((await request(`echo ok; ${parent}`)).stdout).toBe("ok\nru\n");
});

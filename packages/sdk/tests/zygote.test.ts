// The guest zygote (SBX-78): Freestyle and Superserve fork each command's supervisor from a warm
// interpreter. These drive the real client, zygote and Freestyle supervisor on Linux. Native exec
// hands the client pipes, so the harness does too; the provider fakes hand it sockets, which the
// zygote refuses, so provider tests cover the fallback. superserve-zygote.test.ts drives
// Superserve's warm path through its own execute().
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
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

test("an old claim stays while its command runs, so the command runs exactly once", async () => {
  // The second one-shot starts a zygote when none is running yet.
  await request("true");
  await request("true");
  const { dir } = await zygotePid();
  const counter = join(base, `runs-${crypto.randomUUID()}`);
  // Claims of the two warm-up requests can still be on disk on a loaded host; only a new one is ours.
  const earlier = new Set((await readdir(dir)).filter((entry) => entry.startsWith("c-")));
  // Longer than the zygote's 5 s sweep tick, so a sweep runs while the claim is live.
  const running = request(`echo x >> ${counter}; ${parent}; sleep 7; echo done`);
  let claim: string | undefined;

  for (let attempt = 0; attempt < 200 && !claim; attempt++) {
    claim = (await readdir(dir)).find((entry) => entry.startsWith("c-") && !earlier.has(entry));

    if (!claim) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(claim).toBeDefined();
  // Older than any age limit: only the client's and the worker's liveness may release it.
  const old = Date.now() / 1000 - 3600;
  await utimes(join(dir, claim ?? ""), old, old);
  // Past the zygote's next sweep tick, the worker that took the request still owns it.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const owner = (await readFile(join(dir, claim ?? ""), "utf8")).split(/\s/)[0];
  expect(owner).toMatch(/^\d+$/);

  expect(await running).toMatchObject({ exitCode: 0, stdout: "z-\ndone\n" });
  expect(await readFile(counter, "utf8")).toBe("x\n");
});

test("the sweep drops claims whose client and worker are gone, and keeps live ones", async () => {
  await request("true");
  const { dir } = await zygotePid();
  const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const claim = (owners: string) => writeFile(join(dir, `c-${crypto.randomUUID()}`), `${owners}\n`);
  // PIDs past the kernel's pid_max cannot be live.
  await claim(`9999999 - 9999998 - ${boot}`);
  await claim(`- - 9999998 - 00000000-0000-0000-0000-000000000000`);
  await claim(`- - ${process.pid} - ${boot}`);
  await claim("");
  // Past the zygote's next 5 s sweep tick.
  await new Promise((resolve) => setTimeout(resolve, 6000));

  const left = await Promise.all(
    (await readdir(dir))
      .filter((entry) => entry.startsWith("c-"))
      .map((entry) => readFile(join(dir, entry), "utf8")),
  );

  expect(left.sort()).toEqual(["\n", `- - ${process.pid} - ${boot}\n`]);
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

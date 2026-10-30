// Superserve's warm zygote path (SBX-78), end to end on Linux. execute() builds each command
// exactly as the provider sends it; the guest below stands in for Superserve's two transports
// over real pipes. POST /exec (`run`) takes the command and its env, and the spec rides in the
// command as a heredoc with only the env names in it. The exec session (`exec`) writes the
// spec, env values and stdin included, to the command's stdin. The server passes env in the
// command's process environment, so the zygote reads it from /proc. Both shells cover the
// heredoc and fd handling a template's /bin/sh may use.
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, type ExecutionGuest } from "../src/providers/superserve/execute.js";

vi.setConfig({ testTimeout: 30000 });

// The supervisor's last argument: the zygote directory when a zygote child ran the request,
// the run directory or spec when the client ran the supervisor itself.
const parent = "tr '\\0' '\\n' </proc/$PPID/cmdline | tail -1 | sed 's|.*/||' | cut -c1-2";

// Values a shell would mangle if they ever passed through one unquoted.
const env = {
  SPACED: "a b  c",
  QUOTED: `it's "q" $HOME \`id\` \\n`,
  MULTI: "line 1\nline 2\n",
  EMPTY: "",
  WIDE: "雪🙂",
};

const printEnv = `printf '<%s>' "$SPACED" "$QUOTED" "$MULTI" "$EMPTY" "$WIDE"`;
const printed = `<a b  c><it's "q" $HOME \`id\` \\n><line 1\nline 2\n><><雪🙂>`;

type Transport = "run" | "exec";

interface Outcome {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  transport: Transport;
}

/** A Superserve guest whose /tmp/.sandbox-sdk lives under `base`, run by `shell`. */
function superserve(shell: string, base: string) {
  const local = (text: string) =>
    text.replaceAll("/tmp/.sandbox-sdk", join(base, "tmp/.sandbox-sdk"));

  const transports: Transport[] = [];

  // A pipeline gives the command's shell pipes on fds 0-2, as a native exec does;
  // spawn's own stdio are sockets, which the zygote refuses.
  function sh(command: string, variables: Record<string, string>, stdin: string) {
    const id = crypto.randomUUID();

    const errors = join(base, `${id}.err`),
      status = join(base, `${id}.status`);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        "sh",
        [
          "-c",
          'cat | { "$1" -c "$2" 2>"$3"; echo "$?" >"$4"; } | cat',
          "sh",
          shell,
          local(command),
          errors,
          status,
        ],
        { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...variables } },
      );

      let text = "";
      child.stdout.on("data", (bytes: Buffer) => (text += bytes.toString()));
      child.on("error", reject);
      child.on("close", async () => {
        const code = (await readFile(status, "utf8")).trim();

        if (code === "0") resolve(text);
        else reject(new Error(`exit ${code}: ${await readFile(errors, "utf8")}`));
      });
      child.stdin.end(stdin);
    });
  }

  const guest: ExecutionGuest = {
    id: `superserve-${crypto.randomUUID()}`,
    raw: (command) => sh(command, {}, ""),
    read: async (path, range) =>
      (await readFile(local(path))).subarray(range.offset, range.offset + range.length),
    run: (command, variables) => {
      transports.push("run");

      return sh(command, variables, "");
    },
    exec: (command, stdin) => {
      transports.push("exec");

      return sh(command, {}, stdin);
    },
  };

  async function request(
    command: string,
    options: { stdin?: string; env?: Record<string, string> } = {},
  ): Promise<Outcome> {
    const output = { stdout: "", stderr: "" };

    const result = await execute(guest, {
      command,
      cwd: base,
      env: options.env ?? {},
      stdin: options.stdin,
      timeoutMs: 10000,
      onChunk: (chunk) => (output[chunk.stream] += chunk.text),
    });

    const transport = transports.at(-1);

    if (!transport) throw new Error("No transport ran");

    return { ...result, ...output, transport };
  }

  async function zygote() {
    const guestRoot = join(base, "tmp/.sandbox-sdk");

    for (let attempt = 0; attempt < 400; attempt++) {
      try {
        const name = (await readdir(guestRoot)).find((entry) => /^z-[0-9a-f]+$/.test(entry));

        if (name && (await readFile(join(guestRoot, name, "pid"), "utf8")).trim()) return;
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error("The zygote did not start");
  }

  return { request, zygote };
}

describe.each(["dash", "bash"])("Superserve's warm path under %s", (shell) => {
  let base = "";
  let guest: ReturnType<typeof superserve>;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "sdk-superserve-zygote-"));
    guest = superserve(shell, base);
  });

  // Removing the directory also stops the zygote these tests started.
  afterAll(() => rm(base, { recursive: true, force: true }));

  test("the first two commands run the supervisor themselves; the zygote serves the third", async () => {
    // The plain supervisor's last argument is the spec; the zygote one-shot's is the run directory.
    expect((await guest.request(parent)).stdout).not.toBe("z-\n");
    expect(await guest.request(parent)).toMatchObject({ stdout: "ru\n", transport: "run" });
    await guest.zygote();
    expect(await guest.request(parent)).toMatchObject({ stdout: "z-\n", transport: "run" });
  });

  test("env values reach a warm command through the heredoc spec's env names", async () => {
    await guest.zygote();

    const result = await guest.request(`${printEnv}; echo; echo err >&2; ${parent}; exit 3`, {
      env,
    });

    expect(result).toEqual({
      exitCode: 3,
      timedOut: false,
      stdout: `${printed}\nz-\n`,
      stderr: "err\n",
      transport: "run",
    });
  });

  test("stdin and env values reach a warm command through the spec on stdin", async () => {
    await guest.zygote();

    const result = await guest.request(`cat; ${printEnv}; echo; ${parent}`, {
      stdin: "in-雪\nline 'two' \"$x\"\n",
      env,
    });

    expect(result).toEqual({
      exitCode: 0,
      timedOut: false,
      stdout: `in-雪\nline 'two' "$x"\n${printed}\nz-\n`,
      stderr: "",
      transport: "exec",
    });
  });

  test("a heredoc past the pipe buffer and a command past the inline limit both run warm", async () => {
    await guest.zygote();

    // About 70 KB of hex spec: more than a pipe holds, under the 96 KiB inline limit.
    const inline = await guest.request(`: ${"x".repeat(35000)}; ${printEnv}; echo; ${parent}`, {
      env,
    });

    expect(inline).toMatchObject({ exitCode: 0, stdout: `${printed}\nz-\n`, transport: "run" });

    const large = await guest.request(`: ${"x".repeat(60000)}; ${printEnv}; echo; ${parent}`, {
      env,
    });

    expect(large).toMatchObject({ exitCode: 0, stdout: `${printed}\nz-\n`, transport: "exec" });
  });

  test("output past the first page comes back through ranged reads from a warm command", async () => {
    await guest.zygote();
    const result = await guest.request(`head -c 300000 /dev/zero | tr '\\0' x; ${parent} >&2`);
    expect(result).toMatchObject({ exitCode: 0, stderr: "z-\n", transport: "run" });
    expect(result.stdout).toBe("x".repeat(300000));
  });
});

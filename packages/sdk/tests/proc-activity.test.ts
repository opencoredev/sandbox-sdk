import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSandbox, reapSandboxes } from "../src/index.js";
import { activityScanCommand, activityTag } from "../src/run.js";
import type { ExecInput, Provider } from "../src/provider.js";
import { shellProvider } from "./shell-provider.js";
import { isNumber, isObject } from "../src/shared/narrow.js";

const run = promisify(execFile);

/** The shell test transport, flagged as a /proc adapter. Every exec input is recorded. */
async function procShell(
  scan?: (input: ExecInput) => Promise<{ exitCode: number | null; timedOut: boolean }>,
) {
  const native = await shellProvider();
  const inputs: ExecInput[] = [];

  const provider: Provider = {
    ...native,
    procActivity: true,
    exec(id, input) {
      inputs.push(input);

      return scan && input.command === activityScanCommand ? scan(input) : native.exec(id, input);
    },
  };

  return { provider, inputs };
}

describe("procActivity runs", () => {
  test("a run is one exec with no marker and the tag in its environment", async () => {
    const { provider, inputs } = await procShell();
    const box = await createSandbox(provider);

    try {
      inputs.length = 0;
      expect((await box.run(`printf %s "$${activityTag}"`)).stdout).toBe("1");
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.command).not.toContain("/tmp/.sandbox-sdk/runs");
      expect(await box.files.exists("/tmp/.sandbox-sdk/runs")).toBe(false);
    } finally {
      await box.destroy();
    }
  });

  test("shell semantics survive: stdin, exit, exec, traps, comments, umask and signals", async () => {
    const { provider } = await procShell();
    const box = await createSandbox(provider);

    try {
      let rawMask = "";
      await provider.exec(box.id, {
        command: "umask",
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
        onChunk(chunk) {
          rawMask += chunk.text;
        },
      });
      expect((await box.run("umask")).stdout).toBe(rawMask);
      expect(await box.run("cat; printf err >&2; exit 7", { stdin: "input\n" })).toMatchObject({
        stdout: "input\n",
        stderr: "err",
        exitCode: 7,
      });
      expect(await box.run("exec sh -c 'printf replaced; exit 9'")).toMatchObject({
        stdout: "replaced",
        exitCode: 9,
      });
      expect(await box.run("trap 'printf trapped' EXIT; exit 3 # comment")).toMatchObject({
        stdout: "trapped",
        exitCode: 3,
      });
      expect(await box.run("# trailing comment\nexit 23 # no newline")).toMatchObject({
        exitCode: 23,
      });
      expect((await box.run("cat; printf '%s' \"$0:$#\"", { stdin: "input\n" })).stdout).toBe(
        "input\nsh:0",
      );
      expect((await box.run("kill -KILL $$")).exitCode).toBe(137);
      expect(await box.run("sleep 5", { timeoutMs: 50 })).toMatchObject({
        timedOut: true,
        exitCode: null,
      });
    } finally {
      await box.destroy();
    }
  });

  test("the tagged parent is alive and tagged while an env -i child runs", async () => {
    const { provider } = await procShell();
    const box = await createSandbox(provider);

    try {
      let parent = "";

      const running = box.run(`exec env -i /bin/sh -c 'echo "$PPID"; sleep 1'`, {
        timeoutMs: 10_000,
      });

      for await (const chunk of running) {
        parent += chunk.text;

        if (parent.includes("\n")) break;
      }

      const environ = await fs.readFile(`/proc/${parent.trim()}/environ`, "latin1");
      expect(environ.split("\0")).toContain(`${activityTag}=1`);
      expect((await running).exitCode).toBe(0);
    } finally {
      await box.destroy();
    }
  });
});

describe("idle reaping on procActivity adapters", () => {
  for (const [label, outcome, reaped] of [
    ["an untagged scan", { exitCode: 0, timedOut: false }, 1],
    ["a tagged process", { exitCode: 10, timedOut: false }, 0],
    ["an unreadable process", { exitCode: 11, timedOut: false }, 0],
    ["a failed scan", { exitCode: 2, timedOut: false }, 0],
    ["a timed-out scan", { exitCode: null, timedOut: true }, 0],
  ] as const) {
    test(`${label} reaps ${reaped}`, async () => {
      const { provider, inputs } = await procShell(async () => outcome);
      const box = await createSandbox(provider);

      try {
        expect(await reapSandboxes(provider, { idleOnly: true })).toBe(reaped);
        const scan = inputs.find((input) => input.command === activityScanCommand);
        // The scan itself carries no tag, so it can never see itself.
        expect(scan?.env).toEqual({});
      } finally {
        await box.destroy();
      }
    });
  }

  test("a scan transport failure keeps the sandbox", async () => {
    const { provider } = await procShell(async () => {
      throw new Error("transport closed");
    });

    const box = await createSandbox(provider);

    try {
      expect(await reapSandboxes(provider, { idleOnly: true })).toBe(0);
    } finally {
      await box.destroy();
    }
  });
  test("reaping without idleOnly never scans", async () => {
    const { provider, inputs } = await procShell(async () => ({ exitCode: 10, timedOut: false }));
    await createSandbox(provider);
    expect(await reapSandboxes(provider)).toBe(1);
    expect(inputs.some((input) => input.command === activityScanCommand)).toBe(false);
  });
  test("a marker written by an older client still blocks reaping", async () => {
    const { provider } = await procShell(async () => ({ exitCode: 0, timedOut: false }));
    const box = await createSandbox(provider);

    try {
      await box.files.write("/tmp/.sandbox-sdk/runs/older-client", "");
      expect(await reapSandboxes(provider, { idleOnly: true })).toBe(0);
    } finally {
      await box.destroy();
    }
  });
});

describe("activity scan script", () => {
  // The script runs on this host against a fake /proc and a fake sudo on PATH.
  async function scan(
    processes: Record<string, { environ: string; readable?: boolean }>,
    sudo: "missing" | "fails" | "reads",
  ) {
    const root = await fs.mkdtemp(join(tmpdir(), "sdk-scan-"));

    try {
      const proc = join(root, "proc"),
        bin = join(root, "bin");

      await fs.mkdir(proc);
      await fs.mkdir(bin);

      for (const [pid, { environ, readable = true }] of Object.entries(processes)) {
        await fs.mkdir(join(proc, pid));
        await fs.writeFile(join(proc, pid, "environ"), environ, { mode: readable ? 0o400 : 0o000 });
      }

      if (sudo !== "missing")
        await fs.writeFile(
          join(bin, "sudo"),
          sudo === "fails"
            ? "#!/bin/sh\nexit 1\n"
            : `#!/bin/sh\n[ "$1" = -n ] && shift\nchmod u+r ${proc}/*/environ\nexec "$@"\n`,
          { mode: 0o755 },
        );
      const script = activityScanCommand.replaceAll("/proc/", `${proc}/`);
      const env = { PATH: `${bin}:/usr/bin:/bin` };

      try {
        await run("sh", ["-c", script], { env });

        return 0;
      } catch (error) {
        if (isObject(error) && "code" in error && isNumber(error.code)) return error.code;
        throw error;
      } finally {
        for (const pid of Object.keys(processes))
          await fs.chmod(join(proc, pid, "environ"), 0o600).catch(() => {});
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const untagged = "PATH=/bin\0HOME=/root\0";
  const tagged = `HOME=/root\0${activityTag}=1\0`;
  test.skipIf(process.getuid?.() === 0)(
    "idle only when every process is readable and untagged",
    async () => {
      expect(await scan({ "1": { environ: untagged }, "42": { environ: "" } }, "missing")).toBe(0);
      expect(await scan({ "1": { environ: untagged }, "42": { environ: tagged } }, "missing")).toBe(
        10,
      );
      expect(await scan({}, "missing")).not.toBe(0);
    },
  );
  test.skipIf(process.getuid?.() === 0)(
    "unreadable processes are busy unless sudo can read them untagged",
    async () => {
      expect(
        await scan(
          { "1": { environ: untagged, readable: false }, "42": { environ: untagged } },
          "missing",
        ),
      ).not.toBe(0);
      expect(
        await scan(
          { "1": { environ: untagged, readable: false }, "42": { environ: untagged } },
          "fails",
        ),
      ).not.toBe(0);
      expect(
        await scan(
          { "1": { environ: untagged, readable: false }, "42": { environ: untagged } },
          "reads",
        ),
      ).toBe(0);
      expect(
        await scan(
          { "1": { environ: tagged, readable: false }, "42": { environ: untagged } },
          "reads",
        ),
      ).toBe(10);
    },
  );
});

import { expect, test } from "bun:test";
import { runCli } from "../src/cli";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write(value: string) {
        stdout += value;
      },
    },
    stderr: {
      write(value: string) {
        stderr += value;
      },
    },
    env: { E2B_API_KEY: "secret-value" } as NodeJS.ProcessEnv,
    read: () => ({ stdout, stderr }),
  };
}

test("adapters lists built-ins without secrets", async () => {
  const io = capture();
  expect(await runCli(["adapters"], io)).toBe(0);
  expect(io.read().stdout).toContain("memory");
  expect(io.read().stdout).toContain("e2b");
  expect(io.read().stdout).not.toContain("secret-value");
});

test("doctor reports present env names only", async () => {
  const io = capture();
  expect(await runCli(["doctor"], io)).toBe(0);
  expect(io.read().stdout).toContain("e2b\tpresent");
  expect(io.read().stdout).not.toContain("secret-value");
});

test("capabilities prints advertised modes", async () => {
  const io = capture();
  expect(await runCli(["capabilities", "--adapter", "memory"], io)).toBe(0);
  expect(io.read().stdout).toContain("files.read");
});

test("run requires --live for non-memory adapters and can run memory", async () => {
  const blocked = capture();
  expect(await runCli(["run", "--adapter", "e2b", "--", "true"], blocked)).toBe(1);
  expect(blocked.read().stderr).toContain("--live");
  const io = capture();
  expect(await runCli(["run", "--adapter", "memory", "--", "echo", "ready"], io)).toBe(0);
  expect(io.read().stdout).toContain("ready");
});

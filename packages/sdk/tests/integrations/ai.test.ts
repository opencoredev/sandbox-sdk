import { describe, expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { createSandboxToolApproval, createSandboxTools, toAISandboxSession } from "../../src/ai";
import { local } from "../../src/providers/local";

async function setup() {
  const sandbox = await createSandbox({ provider: local(), cwd: "/workspace" });
  return { sandbox, ai: toAISandboxSession(sandbox) };
}

describe("AI SDK adapter", () => {
  test("maps files, encodings, ranges, and missing files", async () => {
    const { sandbox, ai } = await setup();
    await ai.writeTextFile({ path: "lines.txt", content: "one\ntwo\nthree", encoding: "utf-8" });
    expect(await ai.readTextFile({ path: "lines.txt", startLine: 2, endLine: 3 })).toBe(
      "two\nthree",
    );
    await ai.writeBinaryFile({ path: "bytes.bin", content: new Uint8Array([0, 255]) });
    expect([...(await ai.readBinaryFile({ path: "bytes.bin" }))!]).toEqual([0, 255]);
    expect(await ai.readTextFile({ path: "missing.txt" })).toBeNull();
    await sandbox.stop();
  });

  test("provides AgentOS shell output and the real exit code", async () => {
    const { sandbox, ai } = await setup();
    const process = await ai.spawn({ command: "printf out; printf err >&2; exit 9" });
    const [stdout, stderr, result] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.wait(),
    ]);
    expect({ stdout, stderr, ...result }).toEqual({ stdout: "outerr", stderr: "", exitCode: 9 });
    await process.kill();
    await process.kill();
    await sandbox.stop();
  });

  test("configures approval modes", () => {
    expect(createSandboxToolApproval()).toEqual({
      bash: "user-approval",
      read_file: "not-applicable",
      write_file: "user-approval",
    });
    expect(createSandboxToolApproval("always")).toEqual({
      bash: "user-approval",
      read_file: "user-approval",
      write_file: "user-approval",
    });
    expect(createSandboxToolApproval("never")).toEqual({
      bash: "not-applicable",
      read_file: "not-applicable",
      write_file: "not-applicable",
    });

    const tools = createSandboxTools();
    expect(tools.bash.needsApproval).toBeUndefined();
    expect(tools.read_file.needsApproval).toBeUndefined();
    expect(tools.write_file.needsApproval).toBeUndefined();
  });
});

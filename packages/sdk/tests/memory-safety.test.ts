import { expect, test } from "vitest";
import { createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";

test("memory does not advertise or accept unenforceable machine size", async () => {
  const provider = memory();
  expect([...provider.capabilities]).not.toContain("size");

  for (const size of ["small", { cpu: 1, memoryMb: 512, diskGb: 1 }] satisfies NonNullable<
    import("../src/provider.js").CreateInput["size"]
  >[]) {
    await expect(createSandbox(provider, { size })).rejects.toMatchObject({ code: "unsupported" });
  }
});

test.each([
  ["echo a | cat", "|"],
  ["echo a & echo b", "&"],
  ["echo a >> out", ">>"],
  ["echo a < input", "<"],
  ["echo a 2> err", "2>"],
  ["echo a >", ">"],
  ["echo a > out extra", ">"],
  ["echo a &&", "&&"],
  ["echo a >&2 > out", ">"],
])("memory rejects unsupported syntax before running %s", async (command, syntax) => {
  const box = await createSandbox(memory());

  try {
    const result = await box.run(command);
    expect(result).toMatchObject({ ok: false, exitCode: 127, stdout: "" });
    expect(result.stderr).toContain("Unsupported shell syntax");
    expect(result.stderr).toContain(syntax);
    expect(await box.files.exists("out")).toBe(false);
  } finally {
    await box.destroy();
  }
});

test("memory preserves implemented conditionals, redirects, quoted and escaped operators", async () => {
  const box = await createSandbox(memory());

  try {
    expect((await box.run("false && echo no; true && echo yes")).stdout).toBe("yes\n");
    expect((await box.run("echo saved > out; cat out")).stdout).toBe("saved\n");
    expect((await box.run("echo error >&2")).stderr).toBe("error\n");
    expect((await box.run("echo 'a | cat' \"x >> y\" a\\&b")).stdout).toBe("a | cat x >> y a&b\n");
  } finally {
    await box.destroy();
  }
});

test("the memory shell treats backslashes as POSIX sh does", async () => {
  await using box = await createSandbox(memory());
  const run = async (command: string) => (await box.run(command)).stdout;

  // Unquoted, a backslash keeps the next character: \n is n.
  expect(await run("echo a\\nb")).toBe("anb\n");
  // In double quotes it stays before other characters, so printf still expands \n.
  expect(await run('printf "a\\nb"')).toBe("a\nb");
  // It escapes $ and " in double quotes, and the next character anywhere outside quotes.
  expect(await run('echo "\\$HOME \\"q\\""')).toBe('$HOME "q"\n');
  expect(await run("echo \\$HOME")).toBe("$HOME\n");
});

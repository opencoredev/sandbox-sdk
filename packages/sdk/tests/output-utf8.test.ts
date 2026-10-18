import { expect, test } from "vitest";
import { createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";

test("preserves Unicode across output buffer halves and cuts only at code point boundaries", async () => {
  const output = "HEAD\n" + "界".repeat(100) + "\nTAIL";
  await using box = await createSandbox(memory({ handlers: { unicode({ stdout }) { stdout(output); return 0; } } }));
  expect((await box.run("unicode", { maxOutputBytes: 400 })).stdout).toBe(output);
  const capped = await box.run("unicode", { maxOutputBytes: 60 });
  expect(capped.stdout).toContain("HEAD"); expect(capped.stdout).toContain("TAIL");
  expect(capped.stdout).toContain("bytes cut"); expect(capped.stdout).not.toContain("\uFFFD");
});

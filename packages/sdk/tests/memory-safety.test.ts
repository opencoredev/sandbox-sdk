import { expect, test } from "vitest";
import { createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";

test("memory does not advertise or accept unenforceable machine size", async () => {
  const provider = memory();
  expect([...provider.capabilities]).not.toContain("size");
  for (const size of ["small", { cpu: 1, memoryMb: 512, diskGb: 1 }] satisfies NonNullable<import("../src/provider.js").CreateInput["size"]>[]) {
    await expect(createSandbox(provider, { size })).rejects.toMatchObject({ code: "unsupported" });
  }
});

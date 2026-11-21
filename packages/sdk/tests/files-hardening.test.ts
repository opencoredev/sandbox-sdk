import { describe, expect, test } from "vitest";
import { createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";
import { shellProvider } from "./shell-provider.js";

const bom = [0xef, 0xbb, 0xbf];

describe("files.read and files.edit keep a UTF-8 BOM", () => {
  test("read returns the BOM, and edit on an RPC provider writes it back", async () => {
    // memory has no editInGuest, so edit goes through read() and write().
    await using box = await createSandbox(memory());
    await box.files.write("bom.txt", new Uint8Array([...bom, ...new TextEncoder().encode("a=1")]));

    expect(await box.files.read("bom.txt")).toBe("﻿a=1");

    await box.files.edit("bom.txt", { find: "a=1", replace: "a=2" });

    expect([...(await box.files.read("bom.txt", { as: "bytes" }))]).toEqual([
      ...bom,
      ...new TextEncoder().encode("a=2"),
    ]);
  });
});

describe("files.changes validates both git object IDs", () => {
  test("a guest tree ID that is not hex is rejected before it reaches a shell", async () => {
    const provider = await shellProvider();
    const exec = provider.exec.bind(provider);
    const commands: string[] = [];
    await using box = await createSandbox(provider, { trackChanges: true });

    provider.exec = async (id, input) => {
      commands.push(input.command);

      if (!input.command.includes("write-tree")) return exec(id, input);

      // A compromised guest answers the tree script with a shell payload instead of an ID.
      return exec(id, { ...input, command: "printf '%s\\n' '; touch /workspace/pwned'" });
    };

    await expect(box.files.changes()).rejects.toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("Invalid git checkpoint"),
    });
    expect(commands.some((command) => command.includes("pwned") && command.includes("diff"))).toBe(
      false,
    );
    provider.exec = exec;
    expect(await box.files.exists("pwned")).toBe(false);
  });
});

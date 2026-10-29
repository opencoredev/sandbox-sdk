import { expect, test } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
import type { RunResult } from "../src/types.js";
import { shellProvider } from "./shell-provider.js";

test.each(["outcome_unknown", "provider"] satisfies ("outcome_unknown" | "provider")[])(
  "cancellation propagates %s cleanup failures",
  async (code) => {
    const base = memory();

    const provider: Provider = {
      ...base,
      async exec(_, input) {
        if (input.command !== "cancel") return base.exec(_, input);
        await new Promise<void>((resolve) =>
          input.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw new SandboxError("Remote group termination failed", { code });
      },
    };

    const box = await createSandbox(provider);

    try {
      await expect(box.run("cancel", { timeoutMs: 20 })).rejects.toMatchObject({ code });
    } finally {
      await box.destroy();
    }
  },
);

test("a RunHandle is a lazy Promise: then, catch and finally work and streaming still does", async () => {
  const box = await createSandbox(await shellProvider());

  try {
    const handle = box.run("echo hi");
    expect(String(handle)).toBe("[object RunHandle]");
    const promise: Promise<RunResult> = handle;
    let finished = false;
    expect(
      await promise.finally(() => {
        finished = true;
      }),
    ).toMatchObject({ ok: true, stdout: "hi\n" });
    expect(finished).toBe(true);
    // .catch runs the command and receives its rejection.
    const error = await box.run("true", { timeoutMs: -1 }).catch((error) => error);
    expect(error).toMatchObject({ code: "invalid_argument" });
    expect(await box.run("echo caught").catch(() => undefined)).toMatchObject({
      stdout: "caught\n",
    });
    expect(await Promise.all([box.run("echo a"), box.run("echo b")])).toEqual([
      expect.objectContaining({ stdout: "a\n" }),
      expect.objectContaining({ stdout: "b\n" }),
    ]);
    // Nothing runs until the handle is awaited or iterated, so chaining still works.
    const lazy = box.run("pwd");
    lazy.cwd("/tmp");
    expect((await lazy).cwd).toBe("/tmp");
    const chunks = [];

    for await (const chunk of box.run("echo streamed")) chunks.push(chunk.text);
    expect(chunks.join("")).toBe("streamed\n");
  } finally {
    await box.destroy();
  }
});

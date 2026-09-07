import { expect, test } from "bun:test";
import { memory } from "../../src/providers/memory";

test("createSandbox rejects an already-aborted signal before the adapter runs", async () => {
  const signal = AbortSignal.abort(new Error("cancel create"));
  await expect(memory().create({ signal })).rejects.toThrow("cancel create");
});

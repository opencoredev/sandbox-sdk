import { expect, test } from "bun:test";
import { memory } from "../../src/providers/memory";

test("memory is not a security boundary and fail-closes ports", async () => {
  await using sandbox = await memory().create();
  expect(sandbox.provider).toBe("memory");
  await expect(sandbox.ports.expose(3000)).rejects.toMatchObject({ code: "unsupported" });
});

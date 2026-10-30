import { test, expect } from "vitest";
import { createSandbox } from "../src/index.js";
import { forgetSandbox, knownKey, rememberKey } from "../src/keys.js";
import { memory } from "../src/memory.js";

test("destroying a keyed sandbox forgets its key", async () => {
  const provider = memory();
  const ids: string[] = [];

  for (let i = 0; i < 20; i++) {
    const box = await createSandbox(provider, { key: `k${i}` });
    expect(knownKey(provider, `k${i}`)).toBe(box.id);
    ids.push(box.id);
    await box.destroy();
    expect(knownKey(provider, `k${i}`)).toBeUndefined();
  }

  expect(new Set(ids).size).toBe(20);
});

test("the key cache keeps at most 256 entries, dropping the oldest", () => {
  const provider = memory();

  for (let i = 0; i < 300; i++) rememberKey(provider, `k${i}`, `id${i}`);
  expect(knownKey(provider, "k0")).toBeUndefined();
  expect(knownKey(provider, "k43")).toBeUndefined();
  expect(knownKey(provider, "k44")).toBe("id44");
  expect(knownKey(provider, "k299")).toBe("id299");
  forgetSandbox(provider, "id299");
  expect(knownKey(provider, "k299")).toBeUndefined();
});

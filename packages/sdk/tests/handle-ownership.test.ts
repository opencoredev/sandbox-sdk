import { expect, test } from "vitest";
import { connectSandbox, createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
import type { Locator } from "../src/types.js";

/** A memory provider that records which sandbox IDs had their local resources detached. */
function recordingClose() {
  const backing = memory();
  const closed: string[] = [];

  const provider: Provider = {
    ...backing,
    async close(id) {
      closed.push(id);
    },
  };

  return { provider, closed };
}

test("closing one handle leaves another handle's resources attached", async () => {
  const { provider, closed } = recordingClose();
  const first = await createSandbox(provider, { key: "shared" });
  const second = await createSandbox(provider, { key: "shared" });
  const third = await connectSandbox(provider, first.id);

  expect(second.id).toBe(first.id);
  await first.close();
  await first.close();
  expect(closed).toEqual([]);
  expect((await second.run("echo still-attached")).stdout).toContain("still-attached");
  await second.close();
  expect(closed).toEqual([]);
  await third.close();
  expect(closed).toEqual([first.id]);
  await provider.destroy(first.id);
});

test("a handle whose close failed can retry without detaching the others", async () => {
  const { provider: recording, closed } = recordingClose();
  let failures = 1;

  const provider: Provider = {
    ...recording,
    async close(id) {
      if (failures-- > 0) throw new Error("detach failed");
      await recording.close?.(id);
    },
  };

  const first = await createSandbox(provider, { key: "retry" });
  const second = await connectSandbox(provider, first.id);

  await second.close();
  await expect(first.close()).rejects.toThrow("detach failed");
  await first.close();
  expect(closed).toEqual([first.id]);
  await provider.destroy(first.id);
});

test("destroy keeps the locator entry of a replacement created meanwhile", async () => {
  const backing = memory();
  let finishDestroy = () => {};

  const destroyGate = new Promise<void>((resolve) => {
    finishDestroy = resolve;
  });

  let destroying = false;

  const provider: Provider = {
    ...backing,
    async destroy(id) {
      await backing.destroy(id);
      destroying = true;
      await destroyGate;
    },
  };

  const store = new Map<string, string>();

  const locator: Locator = {
    get: async (key) => store.get(key),
    set: async (key, id) => {
      store.set(key, id);
    },
    delete: async (key) => {
      store.delete(key);
    },
  };

  const old = await createSandbox(provider, { key: "k", locator });
  const destroyed = old.destroy();

  await expect.poll(() => destroying).toBe(true);
  const replacement = await createSandbox(provider, { key: "k", locator });

  expect(replacement.id).not.toBe(old.id);
  finishDestroy();
  await destroyed;
  expect(store.get("k")).toBe(replacement.id);
  await replacement.destroy();
  expect(store.has("k")).toBe(false);
});

test("destroy waits for the locator lock that creation takes", async () => {
  const backing = memory();
  const provider: Provider = { ...backing, keyMode: "best-effort" };
  const store = new Map<string, string>();
  const events: string[] = [];

  const locator: Locator = {
    get: async (key) => store.get(key),
    set: async (key, id) => {
      store.set(key, id);
    },
    delete: async (key) => {
      events.push("delete");
      store.delete(key);
    },
    async withLock(key, action) {
      events.push(`lock ${key}`);

      try {
        return await action();
      } finally {
        events.push(`unlock ${key}`);
      }
    },
  };

  const box = await createSandbox(provider, { key: "locked", keyMode: "exact", locator });

  events.length = 0;
  await box.destroy();
  expect(events).toEqual(["lock locked", "delete", "unlock locked"]);
  expect(store.has("locked")).toBe(false);
});

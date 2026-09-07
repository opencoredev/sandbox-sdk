import { expect, test } from "bun:test";
import { memory } from "../../src/providers/memory";

test("hooks observe create, run, and stop without file contents or env", async () => {
  const events: string[] = [];
  await using sandbox = await memory().create({
    env: { SECRET: "do-not-log" },
    hooks: {
      onCreate: (event) => {
        events.push(`create:${event.provider}:${event.id}`);
      },
      onRun: (event) => {
        events.push(`run:${event.command}:${event.success}`);
      },
      onStop: (event) => {
        events.push(`stop:${event.operation}`);
      },
    },
  });
  await sandbox.files.write("secret.txt", "file-body");
  await sandbox.run("true");
  expect(events.join(" ")).not.toContain("do-not-log");
  expect(events.join(" ")).not.toContain("file-body");
  expect(events.some((event) => event.startsWith("create:memory"))).toBe(true);
  expect(events).toContain("run:true:true");
});

test("onError redacts tokens and does not break the thrown error", async () => {
  const messages: string[] = [];
  await using sandbox = await memory().create({
    hooks: {
      onError: (event) => {
        messages.push(event.message ?? "");
      },
    },
  });
  await expect(sandbox.files.read("missing.txt")).rejects.toMatchObject({ code: "not_found" });
  expect(messages.join(" ")).not.toMatch(/token=[^\s[]+/);
});

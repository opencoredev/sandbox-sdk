import { describe, expect, test } from "vitest";
import { connectSandbox, createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
import { rejection } from "./rejection.js";

/** A connected memory sandbox whose secret recovery waits until `release` is called. */
async function slowRecovery() {
  const backing = memory();
  const created = await createSandbox(backing, { secrets: { TOKEN: "secret-value" } });
  await created.files.write("notes.txt", "hello");
  let release = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const commands: string[] = [];
  const reads: string[] = [];

  const provider: Provider = {
    ...backing,
    async exec(id, input) {
      commands.push(input.command);

      return backing.exec(id, input);
    },
    async readSecretEnvironment(id) {
      await gate;

      return backing.readSecretEnvironment?.(id);
    },
    files: {
      ...backing.files,
      read: (id, path) => {
        reads.push(path);

        return backing.files.read(id, path);
      },
    },
    close: async () => {},
  };

  const box = await connectSandbox(provider, created.id);

  return { box, release, commands, reads, cleanup: () => backing.destroy(created.id) };
}

describe("operations started before close or destroy do not run after it", () => {
  test.each(["close", "destroy"] as const)(
    "run, files.read and start wait for recovery, then fail when %s landed",
    async (which) => {
      const { box, release, commands, reads, cleanup } = await slowRecovery();

      try {
        const run = rejection(box.run("echo after-close"));
        const read = rejection(box.files.read("notes.txt"));
        const start = rejection(box.start("sleep 1", { name: "late" }));

        await new Promise((resolve) => setTimeout(resolve, 10));
        await box[which]();
        release();

        for (const outcome of await Promise.all([run, read, start]))
          expect(outcome).toMatchObject({
            code: "not_found",
            message: expect.stringContaining("handle is closed"),
          });
        expect(commands).toEqual([]);
        expect(reads).toEqual([]);
      } finally {
        release();
        await cleanup().catch(() => {});
      }
    },
  );
});

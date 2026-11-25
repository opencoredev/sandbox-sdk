import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createSandbox, SandboxError, withRetry } from "../src/index.js";
import { memory } from "../src/memory.js";
import { shellProvider } from "./shell-provider.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function errorCodeOf<T>(action: () => Promise<T>): Promise<string> {
  try {
    await action();

    return "resolved";
  } catch (error) {
    return error instanceof SandboxError ? error.code : String(error);
  }
}

test("ProcessHandle.wait enforces timeoutMs and signal even when provider stat stalls", async () => {
  const provider = memory();
  const box = await createSandbox(provider);
  const proc = await box.start("sleep 30", { name: "stalled-wait" });
  const originalStat = provider.files.stat;

  provider.files.stat = (id, path) =>
    path.endsWith("/exit") ? new Promise(() => {}) : originalStat(id, path);

  try {
    const timed = await Promise.race([
      errorCodeOf(() => proc.wait({ timeoutMs: 25 })),
      delay(250).then(() => "hung"),
    ]);

    expect(timed).toBe("timeout");

    const controller = new AbortController();

    const pending = errorCodeOf(() => proc.wait({ signal: controller.signal }));

    controller.abort();

    const aborted = await Promise.race([pending, delay(250).then(() => "hung")]);

    expect(aborted).toBe("aborted");
  } finally {
    provider.files.stat = originalStat;
    await proc.stop({ graceMs: 0 });
    await box.destroy();
  }
});

test("withRetry rejects promptly when signal aborts inside action before backoff", async () => {
  const controller = new AbortController();

  const retrying = errorCodeOf(() =>
    withRetry(
      async () => {
        controller.abort();
        throw new SandboxError("transient", {
          code: "quota",
          retryable: true,
          retryAfterMs: 1_000,
        });
      },
      { signal: controller.signal, baseDelayMs: 0 },
    ),
  );

  const outcome = await Promise.race([retrying, delay(200).then(() => "hung")]);

  expect(outcome).toBe("aborted");
});

test.skipIf(process.getuid?.() === 0)(
  "directory tar upload and download permission failures map to auth",
  async () => {
    const target = await mkdtemp(join(tmpdir(), "sandbox-sdk-tar-perm-"));
    const remote = await createSandbox(await shellProvider());

    try {
      await remote.files.write("dir/out.txt", "data");
      await chmod(target, 0o500);
      await expect(remote.files.download("dir", target)).rejects.toMatchObject({ code: "auth" });

      await chmod(target, 0o700);
      const blocked = join(target, "private.txt");
      await writeFile(blocked, "secret");
      await chmod(blocked, 0o000);
      await expect(remote.files.upload(target, "in")).rejects.toMatchObject({ code: "auth" });
    } finally {
      await chmod(target, 0o700);
      await rm(target, { recursive: true, force: true });
      await remote.destroy();
    }
  },
);

import { afterAll, describe, expect, test, vi } from "vitest";
import { boxdState, MockBoxd } from "./cloud-guest-mock.js";
vi.mock("@boxd-sh/sdk", () => ({ Boxd: MockBoxd }));
import { boxd } from "../src/providers/boxd/index.js";
import { boxdError } from "../src/providers/boxd/errors.js";
import { createSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const factory = () => boxd({ apiKey: "mock-key" });
// The conformance guard admits local transports only when live:false. This is
// a local Linux transport, not permission to contact the cloud.
runConformance(() => ({ ...factory(), name: "memory" }), { live: false });
afterAll(async () => {
  await Promise.all([...boxdState.boxes.values()].map((v) => v.guest.destroy()));
  boxdState.boxes.clear();
});
describe("boxd contract", () => {
  test("rejects every unenforceable option before allocating", async () => {
    const provider = factory();
    const before = boxdState.creates.length;
    for (const opts of [
      { size: "small" },
      { network: "none" },
      { network: { allow: [] } },
      { network: { allow: ["example.com"] } },
      { idleTimeoutMs: 1000 },
      { timeoutMs: 1000 },
      { from: "snap" },
    ] satisfies Partial<Parameters<typeof provider.create>[0]>[])
      await expect(provider.create({ labels: {}, ...opts })).rejects.toMatchObject({
        code: "unsupported",
      });
    expect(boxdState.creates.length).toBe(before);
  });
  test("maps gRPC errors without exposing native credentials", () => {
    for (const [grpcCode, code] of [
      [16, "auth"],
      [7, "auth"],
      [5, "not_found"],
      [8, "quota"],
      [14, "unavailable"],
      [4, "timeout"],
      [3, "invalid_argument"],
      [1, "aborted"],
    ] as const) {
      const error = boxdError(Object.assign(new Error("secret-native-error"), { grpcCode }));
      expect(error.code).toBe(code);
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain("secret-native-error");
    }
  });
  test("maps SDK failures without a gRPC status", () => {
    for (const [name, code] of [
      ["AuthenticationError", "auth"],
      ["PermissionDeniedError", "auth"],
      ["APIConnectionError", "unavailable"],
      ["RateLimitError", "quota"],
    ] as const) {
      const result = boxdError(Object.assign(new Error("private-key"), { name }));
      expect(result.code).toBe(code);
      expect(result.cause).toBeUndefined();
    }
  });
  test("secrets use 0600 files and never command text", async () => {
    const box = await createSandbox(factory(), { secrets: { TOKEN: "secret-$-雪" } });
    try {
      expect((await box.run('test -n "$TOKEN" && echo ok')).stdout).toBe("ok\n");
      const native = boxdState.boxes.get(box.id);
      expect(native).toBeDefined();
      // Inspect a second command whose text has no intentional secret literal.
      const before = native?.guest.commands.length ?? 0;
      await box.run('printf %s "$TOKEN"');
      expect(native?.guest.commands.slice(before).join("\n")).not.toContain("secret-$-雪");
      expect(
        native?.guest.uploads
          .filter((v) => v.path.endsWith("/spec"))
          .every((v) => v.mode === 0o600),
      ).toBe(true);
    } finally {
      await box.destroy();
    }
  });
  test("timeout and abort kill descendants before later writes", async () => {
    const box = await createSandbox(factory());
    try {
      expect(await box.run("(sleep .3; echo leak > late) & wait", { timeoutMs: 40 })).toMatchObject(
        { timedOut: true },
      );
      const abort = new AbortController();
      const pending = Promise.resolve(
        box.run("(sleep .3; echo leak > abort) & wait", { signal: abort.signal }),
      );
      setTimeout(() => abort.abort(), 40);
      expect(await pending).toMatchObject({ timedOut: true });
      await new Promise((r) => setTimeout(r, 350));
      expect(await box.files.exists("late")).toBe(false);
      expect(await box.files.exists("abort")).toBe(false);
    } finally {
      await box.destroy();
    }
  });
});

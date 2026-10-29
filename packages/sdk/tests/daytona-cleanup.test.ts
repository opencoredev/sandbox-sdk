import { afterEach, expect, test, vi } from "vitest";
import { createSandbox, listSandboxes } from "../src/index.js";
import { daytona } from "../src/providers/daytona/index.js";
import { cleanupMock, MockDaytona, MockSandbox, mockState } from "./daytona-mock.js";

vi.mock("@daytonaio/sdk", async () => ({
  Daytona: (await import("./daytona-mock.js")).MockDaytona,
}));

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupMock();
});

/** The error @daytonaio/sdk 0.227 throws when create times out after the sandbox exists. */
const createTimeout = (sandboxId?: string) =>
  Object.assign(
    new Error(
      `Failed to create and start sandbox within 60 seconds. Operation timed out.${sandboxId ? ` Sandbox ${sandboxId} was created before the timeout and may still be starting.` : ""}`,
    ),
    { name: "DaytonaTimeoutError", sandboxId },
  );

test("a create timeout deletes the sandbox Daytona names on the error and reports timeout", async () => {
  let started: string | undefined;
  vi.spyOn(MockDaytona.prototype, "create").mockImplementation(async (params) => {
    const box = await MockSandbox.create(params ?? {});
    started = box.id;
    throw createTimeout(box.id);
  });

  const error = await createSandbox(daytona({ apiKey: "offline" }), {
    labels: { app: "timeout" },
  }).catch((error: unknown) => error);

  expect(error).toMatchObject({ code: "timeout", retryable: true });
  expect(started).toBeDefined();
  expect(mockState.boxes.size).toBe(0);
});

test("a create timeout without a sandbox ID (0.225) still reports timeout and deletes nothing", async () => {
  const other = await createSandbox(daytona({ apiKey: "offline" }));
  vi.spyOn(MockDaytona.prototype, "create").mockRejectedValue(createTimeout());
  await expect(createSandbox(daytona({ apiKey: "offline" }))).rejects.toMatchObject({
    code: "timeout",
  });
  expect([...mockState.boxes.keys()]).toEqual([other.id]);
});

test("cleanup that hangs or fails does not hold the timeout back", async () => {
  vi.spyOn(MockDaytona.prototype, "create").mockRejectedValue(createTimeout("stuck-id"));

  const get = vi
    .spyOn(MockDaytona.prototype, "get")
    .mockImplementation(() => new Promise(() => {}));

  const provider = daytona({ apiKey: "offline" });
  await provider.list({}); // Load the client first, so only the cleanup bound is left on the clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = provider.create({ labels: {} }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toMatchObject({ code: "timeout" });
  expect(get).toHaveBeenCalledWith("stuck-id");
  vi.useRealTimers();
  get.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
  await expect(daytona({ apiKey: "offline" }).create({ labels: {} })).rejects.toMatchObject({
    code: "timeout",
  });
});

test("labels and listSandboxes hide the SDK key and Daytona's code-toolbox-language label", async () => {
  vi.spyOn(MockDaytona.prototype, "create").mockImplementation(async (params) => {
    const box = await MockSandbox.create(params ?? {});
    box.labels = { ...box.labels, "code-toolbox-language": "python" };

    return box;
  });
  const provider = daytona({ apiKey: "offline" });

  const box = await createSandbox(provider, {
    key: "labels-key",
    labels: { app: "daytona-labels" },
  });

  expect(box.labels).toEqual({ app: "daytona-labels", "sandbox-sdk": "1" });

  const [listed] = await listSandboxes(daytona({ apiKey: "offline" }), {
    labels: { app: "daytona-labels" },
  });

  expect(listed).toMatchObject({ id: box.id, key: "labels-key" });
  expect(listed?.labels).toEqual({ app: "daytona-labels", "sandbox-sdk": "1" });
});

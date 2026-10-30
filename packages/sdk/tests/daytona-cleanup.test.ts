import { afterEach, expect, test, vi } from "vitest";
import { createSandbox, listSandboxes } from "../src/index.js";
import { daytona } from "../src/providers/daytona/index.js";
import {
  cleanupMock,
  failure,
  MockDaytona,
  MockSandbox,
  mockState,
  requests,
} from "./daytona-mock.js";

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupMock();
});

test("a create that never starts within createTimeoutMs deletes the sandbox and reports timeout", async () => {
  mockState.createState = "creating";

  const error = await createSandbox(daytona({ apiKey: "offline", createTimeoutMs: 300 }), {
    labels: { app: "timeout" },
  }).catch((error: unknown) => error);

  expect(error).toMatchObject({ code: "timeout", retryable: true });
  expect(mockState.creates).toHaveLength(1);
  expect(mockState.boxes.size).toBe(0);
});

test("a create request lost in flight is found by its label and deleted, and reports timeout", async () => {
  const other = await createSandbox(daytona({ apiKey: "offline" }));
  // Daytona makes the sandbox, but its answer never arrives.
  vi.spyOn(MockDaytona.prototype, "create").mockImplementation(async (params) => {
    mockState.creates.push(params);
    await MockSandbox.create(params);

    return new Promise<never>(() => {});
  });
  await expect(
    createSandbox(daytona({ apiKey: "offline", createTimeoutMs: 300 })),
  ).rejects.toMatchObject({ code: "timeout", retryable: true });
  expect([...mockState.boxes.keys()]).toEqual([other.id]);

  const lookup = requests.find(
    (request) => request.method === "GET" && request.url.startsWith("/api/sandbox?"),
  );

  expect(new URL(lookup?.url ?? "", "http://mock").searchParams.get("labels")).toContain(
    "sandbox-sdk-create",
  );
});

test("a lost create that made nothing is outcome_unknown and deletes nothing", async () => {
  const other = await createSandbox(daytona({ apiKey: "offline" }));
  vi.spyOn(MockDaytona.prototype, "create").mockImplementation(() => new Promise<never>(() => {}));
  await expect(
    createSandbox(daytona({ apiKey: "offline", createTimeoutMs: 300 })),
  ).rejects.toMatchObject({ code: "outcome_unknown" });
  expect([...mockState.boxes.keys()]).toEqual([other.id]);
});

test("cleanup that hangs or fails does not hold the timeout back", async () => {
  mockState.createState = "creating";

  const remove = vi
    .spyOn(MockSandbox.prototype, "delete")
    .mockImplementation(() => new Promise(() => {}));

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });

  const pending = daytona({ apiKey: "offline", createTimeoutMs: 300 })
    .create({ labels: {} })
    .catch((error: unknown) => error);

  await vi.waitFor(() => expect(remove).toHaveBeenCalled(), { timeout: 10_000 });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await pending).toMatchObject({ code: "timeout" });
  vi.useRealTimers();
  remove.mockRejectedValue(failure(404, "not found"));
  await expect(
    daytona({ apiKey: "offline", createTimeoutMs: 300 }).create({ labels: {} }),
  ).rejects.toMatchObject({ code: "timeout" });
});

test("an abort while the sandbox starts deletes it and reports aborted", async () => {
  mockState.createState = "creating";
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await expect(
    daytona({ apiKey: "offline" }).create({ labels: {}, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(mockState.creates).toHaveLength(1);
  expect(mockState.boxes.size).toBe(0);
});

test("labels and listSandboxes hide the SDK key, the create label and Daytona's code-toolbox-language label", async () => {
  const provider = daytona({ apiKey: "offline" });

  const box = await createSandbox(provider, {
    key: "labels-key",
    labels: { app: "daytona-labels" },
  });

  // The official SDK always sends the language label; Daytona's code runner reads it.
  expect(mockState.creates[0]?.labels).toMatchObject({
    "code-toolbox-language": "python",
    "sandbox-sdk-create": expect.any(String),
  });
  expect(box.labels).toEqual({ app: "daytona-labels", "sandbox-sdk": "1" });

  const [listed] = await listSandboxes(daytona({ apiKey: "offline" }), {
    labels: { app: "daytona-labels" },
  });

  expect(listed).toMatchObject({ id: box.id, key: "labels-key" });
  expect(listed?.labels).toEqual({ app: "daytona-labels", "sandbox-sdk": "1" });
});

test("list follows the cursor across pages", async () => {
  const provider = daytona({ apiKey: "offline" });

  const boxes = await Promise.all(
    [1, 2, 3, 4, 5].map(() => createSandbox(provider, { labels: { app: "paged" } })),
  );

  mockState.pageSize = 2;
  const listed = await daytona({ apiKey: "offline" }).list({ app: "paged" });
  expect(listed.map((value) => value.id).sort()).toEqual(boxes.map((box) => box.id).sort());
  expect(
    requests.filter(
      (request) => request.method === "GET" && request.url.startsWith("/api/sandbox?"),
    ).length,
  ).toBe(3);
});

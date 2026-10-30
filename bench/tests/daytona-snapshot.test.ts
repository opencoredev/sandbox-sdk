import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";
import { createNamedDaytonaSnapshot } from "../src/snapshots.js";
import { fakeNativeModules } from "./native-fakes.js";

let server: Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  const open = server;
  server = undefined;

  if (open) await new Promise((resolve) => open.close(resolve));
});

/** Daytona's control plane, as far as `connect` reads it: every sandbox exists and is started. */
async function controlPlane() {
  server = createServer((request, response) => {
    const id = request.url?.match(/^\/sandbox\/([^/?]+)$/)?.[1];

    if (request.method !== "GET" || id === undefined) {
      response.writeHead(404).end();

      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id, state: "started", createdAt: "2026-10-30T00:00:00.000Z" }));
  });

  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(listening.address());

  return `http://127.0.0.1:${port}`;
}

it("creates the preselected Daytona snapshot through the adapter's native SDK handle", async () => {
  const provider = daytona({ apiKey: "offline-key", baseUrl: await controlPlane() });
  await provider.connect("source-box");

  const createSnapshot = vi.fn(async () => {});
  const get = vi.fn(async () => ({ createSnapshot }));

  fakeNativeModules({
    "@daytonaio/sdk": {
      Daytona: class {
        get = get;
        snapshot = { get: vi.fn(), list: vi.fn(), delete: vi.fn() };
      },
    },
  });

  expect(await createNamedDaytonaSnapshot(provider, "source-box", "bench-run-snapshot")).toEqual({
    id: "bench-run-snapshot",
  });
  expect(get).toHaveBeenCalledWith("source-box");
  expect(createSnapshot).toHaveBeenCalledWith("bench-run-snapshot", 600);
});

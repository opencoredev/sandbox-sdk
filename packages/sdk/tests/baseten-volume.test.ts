import { describe, expect, test } from "vitest";
import type { SandboxClient } from "@basetenlabs/sandbox";
import { createBasetenProvider, type BasetenOptions } from "../src/providers/baseten/provider.js";

/** An HTTP error shaped like `SandboxApiError`: an Error with a numeric `status`. */
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

interface FakeState {
  volumes: Map<string, { region: string; attachedTo?: string }>;
  sandboxes: Map<string, { volumes: { name: string; mountPath: string }[]; region?: string }>;
  calls: string[];
  /** Volume deletes refused with 409 before one succeeds, as while a sandbox shuts down. */
  busyDeletes: number;
  rejectCreate?: number;
}

function fakeClient(state: FakeState): SandboxClient {
  const info = (name: string) => {
    const box = state.sandboxes.get(name);

    if (!box) throw httpError(404);

    return {
      name,
      url: `https://${name}.example`,
      status: "DEPLOYED",
      envs: {},
      labels: {},
      ports: [],
      volumes: box.volumes,
      createdAt: new Date(0),
    };
  };

  const sandbox = (name: string) => ({
    name,
    previews: {
      async *list() {},
      async delete() {},
    },
  });

  const client = {
    volumes: {
      async create(request: { name: string; size: string; region?: string }) {
        state.calls.push(`volume.create ${request.name} ${request.size}`);
        state.volumes.set(request.name, { region: request.region ?? "us-pdx-1" });

        return { name: request.name, size: request.size, region: "us-pdx-1", status: "DEPLOYED" };
      },
      async getInfo({ name }: { name: string }) {
        if (!state.volumes.has(name)) throw httpError(404);

        return { name, size: "8Gi", region: "us-pdx-1", status: "DEPLOYED" };
      },
      async delete({ name }: { name: string }) {
        state.calls.push(`volume.delete ${name}`);

        if (!state.volumes.has(name)) throw httpError(404);

        if (state.busyDeletes > 0) {
          state.busyDeletes--;
          throw httpError(409);
        }

        state.volumes.delete(name);
      },
    },
    async create(request: {
      name: string;
      region?: string;
      volumes?: { name: string; mountPath: string }[];
    }) {
      state.calls.push(
        `create ${request.name} ${request.region} ${JSON.stringify(request.volumes ?? [])}`,
      );

      if (state.rejectCreate) throw httpError(state.rejectCreate);
      state.sandboxes.set(request.name, { volumes: request.volumes ?? [], region: request.region });

      return Object.assign(sandbox(request.name), { info: info(request.name) });
    },
    async getInfo({ name }: { name: string }) {
      state.calls.push(`getInfo ${name}`);

      return info(name);
    },
    async get({ info: found }: { info: { name: string } }) {
      return sandbox(found.name);
    },
    async delete({ name }: { name: string }) {
      state.calls.push(`delete ${name}`);

      if (!state.sandboxes.delete(name)) throw httpError(404);
    },
  };

  // SAFETY: the adapter calls only the members above; the rest of SandboxClient is unused.
  return client as never;
}

function setup(options: Partial<BasetenOptions> = {}, extra: Partial<FakeState> = {}) {
  const state: FakeState = {
    volumes: new Map(),
    sandboxes: new Map(),
    calls: [],
    busyDeletes: 0,
    ...extra,
  };

  const provider = createBasetenProvider(
    { apiKey: "test", volume: { sizeGiB: 8, mountPath: "/workspace" }, ...options },
    // SAFETY: the constructor returns the fake client, which is all the adapter reads.
    async () => ({
      SandboxClient: class {
        constructor() {
          return fakeClient(state);
        }
      } as never,
    }),
  );

  return { provider, state };
}

describe("Baseten volume", () => {
  test("create mounts a new volume in its region; destroy deletes it once the sandbox is gone", async () => {
    const { provider, state } = setup({}, { busyDeletes: 2 });

    const box = await provider.create({ labels: {} });

    expect(state.calls[0]).toBe(`volume.create ${box.id}-v 8Gi`);
    expect(state.calls[1]).toBe(
      `create ${box.id} us-pdx-1 [{"name":"${box.id}-v","mountPath":"/workspace"}]`,
    );

    await provider.destroy(box.id);

    expect(state.sandboxes.size).toBe(0);
    expect(state.volumes.size).toBe(0);
    // Deleted only after the sandbox, retrying the 409s Baseten gives while it shuts down.
    expect(state.calls.slice(2)).toEqual([
      `delete ${box.id}`,
      `volume.delete ${box.id}-v`,
      `volume.delete ${box.id}-v`,
      `volume.delete ${box.id}-v`,
    ]);
  }, 10_000);

  test("a rejected sandbox create deletes the volume it made", async () => {
    const { provider, state } = setup({}, { rejectCreate: 400 });

    await expect(provider.create({ labels: {} })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(state.volumes.size).toBe(0);
  });

  test("another client's destroy finds the volume through the sandbox's record", async () => {
    const { provider, state } = setup();
    const box = await provider.create({ labels: {} });

    // SAFETY: the constructor returns the fake client, which is all the adapter reads.
    const other = createBasetenProvider({ apiKey: "test" }, async () => ({
      SandboxClient: class {
        constructor() {
          return fakeClient(state);
        }
      } as never,
    }));

    await other.destroy(box.id);
    expect(state.volumes.size).toBe(0);
  });

  test("a client without the option leaves volumes alone and makes no extra lookup", async () => {
    const { provider, state } = setup({ volume: undefined });
    const box = await provider.create({ labels: {} });

    expect(state.calls.some((c) => c.startsWith("volume."))).toBe(false);
    await provider.destroy(box.id);
    expect(state.calls.filter((c) => c.startsWith("getInfo"))).toEqual([]);
  });

  test("a key with a volume is unsupported", async () => {
    const { provider, state } = setup();

    await expect(provider.create({ key: "k", labels: {} })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(state.calls).toEqual([]);
  });
});

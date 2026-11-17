import { describe, expect, test } from "vitest";
import type { SandboxClient } from "@basetenlabs/sandbox";
import { createBasetenProvider, type BasetenOptions } from "../src/providers/baseten/provider.js";

/** An HTTP error shaped like `SandboxApiError`: an Error with a numeric `status`. */
function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

interface FakeState {
  volumes: Map<string, { region: string; attachedTo?: string }>;
  sandboxes: Map<
    string,
    {
      volumes: { name: string; mountPath: string }[];
      region?: string;
      labels: Record<string, string>;
      /** getInfo calls that still report DEPLOYING with no URL. */
      pendingPolls: number;
    }
  >;
  /** Previews by sandbox name; they outlive the sandbox record, as on Baseten. */
  previews: Map<string, string[]>;
  calls: string[];
  /** Volume deletes refused with 409 before one succeeds, as while a sandbox shuts down. */
  busyDeletes: number;
  /** Volume deletes failing with `failedStatus` (500 by default) before the 409s and the success. */
  failedDeletes?: number;
  failedStatus?: number;
  rejectCreate?: number;
  /** Create makes the sandbox, then throws as the SDK does on a response with no URL. */
  createThrowsAfterAccept?: boolean;
  /** getInfo calls a new sandbox answers DEPLOYING with no URL. */
  newPendingPolls?: number;
}

function fakeClient(state: FakeState): SandboxClient {
  const info = (name: string) => {
    const box = state.sandboxes.get(name);

    if (!box) throw httpError(404);
    const pending = box.pendingPolls > 0;

    if (pending) box.pendingPolls--;

    return {
      name,
      url: pending ? undefined : `https://${name}.example`,
      status: pending ? "DEPLOYING" : "DEPLOYED",
      envs: {},
      labels: box.labels,
      ports: [],
      volumes: box.volumes,
      createdAt: new Date(0),
    };
  };

  const sandbox = (name: string) => ({
    name,
    fs: {
      async writeBytes({ path }: { path: string }) {
        state.calls.push(`write ${name} ${path}`);
      },
    },
    previews: {
      async *list() {
        for (const preview of state.previews.get(name) ?? []) yield { name: preview };
      },
      async delete({ name: preview }: { name: string }) {
        state.calls.push(`preview.delete ${preview}`);
        state.previews.set(
          name,
          (state.previews.get(name) ?? []).filter((p) => p !== preview),
        );
      },
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

        if (state.failedDeletes) {
          state.failedDeletes--;
          throw httpError(state.failedStatus ?? 500);
        }

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
      labels?: Record<string, string>;
      volumes?: { name: string; mountPath: string }[];
    }) {
      state.calls.push(
        `create ${request.name} ${request.region} ${JSON.stringify(request.volumes ?? [])}`,
      );

      if (state.rejectCreate) throw httpError(state.rejectCreate);
      state.sandboxes.set(request.name, {
        volumes: request.volumes ?? [],
        region: request.region,
        labels: request.labels ?? {},
        pendingPolls: state.newPendingPolls ?? 0,
      });

      if (state.createThrowsAfterAccept) throw new Error("Sandbox has no URL yet");

      return Object.assign(sandbox(request.name), { info: info(request.name) });
    },
    async getInfo({ name }: { name: string }) {
      state.calls.push(`getInfo ${name}`);

      return info(name);
    },
    async get({ info: found }: { info: { name: string; url?: string } }) {
      // As @basetenlabs/sandbox 0.5.0: a handle needs the execution URL.
      if (found.url === undefined) throw new Error("Sandbox has no URL yet");

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
    previews: new Map(),
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

  test("a client without the option deletes no volume for its own sandboxes", async () => {
    const { provider, state } = setup({ volume: undefined });
    const box = await provider.create({ labels: {} });

    await provider.destroy(box.id);
    expect(state.calls.filter((c) => c.startsWith("volume."))).toEqual([]);
  });

  test("a client that connected to the sandbox deletes its volume", async () => {
    const { provider, state } = setup();
    const box = await provider.create({ labels: {} });
    const other = setup({ volume: undefined });
    Object.assign(other.state, { volumes: state.volumes, sandboxes: state.sandboxes });

    await other.provider.connect(box.id);
    await other.provider.destroy(box.id);
    expect(state.sandboxes.size).toBe(0);
    expect(state.volumes.size).toBe(0);
  });

  test("a destroy retried after a failed volume delete still deletes the volume", async () => {
    const { provider, state } = setup();
    const box = await provider.create({ labels: {} });

    // A non-retryable failure; a 5xx is retried within the same destroy.
    state.failedDeletes = 1;
    state.failedStatus = 400;
    await expect(provider.destroy(box.id)).rejects.toMatchObject({ code: "provider" });
    expect(state.volumes.size).toBe(1);

    await provider.destroy(box.id);
    expect(state.volumes.size).toBe(0);
  });

  test("a key with a volume is unsupported", async () => {
    const { provider, state } = setup();

    await expect(provider.create({ key: "k", labels: {} })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(state.calls).toEqual([]);
  });
});

describe("Baseten adapter lifecycle", () => {
  test("a create the SDK fails on, with no URL yet, waits for this attempt's sandbox", async () => {
    const { provider, state } = setup(
      { volume: undefined },
      { createThrowsAfterAccept: true, newPendingPolls: 2 },
    );

    const box = await provider.create({ labels: {} });

    expect(state.sandboxes.has(box.id)).toBe(true);
    expect(state.calls.some((c) => c.startsWith("delete"))).toBe(false);
  }, 10_000);

  test("an aborted create that Baseten accepted deletes this attempt's sandbox", async () => {
    const { provider, state } = setup({ volume: undefined }, { createThrowsAfterAccept: true });
    const abort = new AbortController();

    abort.abort();
    await expect(provider.create({ labels: {}, signal: abort.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(state.sandboxes.size).toBe(0);
  });

  test("another client attaching to a sandbox still deploying waits for it", async () => {
    const { provider, state } = setup({ volume: undefined });
    const box = await provider.create({ labels: {} });
    const entry = state.sandboxes.get(box.id);

    if (!entry) throw new Error("Expected the sandbox");
    entry.pendingPolls = 2;

    const other = setup({ volume: undefined });
    Object.assign(other.state, { sandboxes: state.sandboxes, volumes: state.volumes });

    // lookup returns it without a URL; the first operation waits for the deployment.
    await other.provider.connect(box.id);
    await other.provider.files.write(box.id, "/tmp/x", new Uint8Array([1]));
    expect(other.state.calls).toContain(`write ${box.id} /tmp/x`);
    expect(state.sandboxes.has(box.id)).toBe(true);
  }, 10_000);

  test("destroy deletes previews that outlived the sandbox record", async () => {
    const { provider, state } = setup({ volume: undefined });
    const other = setup({ volume: undefined });

    Object.assign(other.state, { previews: state.previews });
    state.previews.set("sbxsdk-gone", ["port-3000"]);

    await other.provider.destroy("sbxsdk-gone");
    expect(state.previews.get("sbxsdk-gone")).toEqual([]);
    expect(provider).toBeDefined();
  });

  test("a 5xx from a volume delete is retried within the same destroy", async () => {
    const { provider, state } = setup({}, { failedDeletes: 1 });
    const box = await provider.create({ labels: {} });

    await provider.destroy(box.id);
    expect(state.volumes.size).toBe(0);
  }, 10_000);
});

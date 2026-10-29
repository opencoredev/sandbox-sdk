import { afterAll, describe, expect, test, vi } from "vitest";
import { MockFreestyle, freestyleState, cleanupFreestyle } from "./freestyle-mock.js";

vi.mock("freestyle", async () => ({
  ...(await vi.importActual("freestyle")),
  Freestyle: MockFreestyle,
}));

import { freestyle } from "../src/providers/freestyle/index.js";
import { freestyleError } from "../src/providers/freestyle/errors.js";
import { createSandbox, connectSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";

const factory = () => freestyle({ apiKey: "mock-key" });

vi.stubGlobal(
  "fetch",
  vi.fn(() => {
    throw new Error("Cloud HTTP is forbidden in offline provider tests");
  }),
);

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

// Only Linux mock transports are used. The name admits the offline transport
// through conformance's live:false cloud guard and skips real cloud HTTP/git.
runConformance(factory, {
  live: true,
  unsupported: {
    gitPush: "The mock guest shares the host /tmp/sdk-bare across runs",
    httpProbe: "Mock freestyle preview URLs point at an unreachable host",
  },
});

afterAll(cleanupFreestyle);

describe("Freestyle official SDK contract", () => {
  test("default-deny has no rules; all grants public outbound only", async () => {
    for (const network of ["none", "all", { allow: [] }] as const) {
      const policy = typeof network === "string" ? network : { allow: [] };
      const box = await createSandbox(factory(), { network: policy });

      try {
        expect(freestyleState.creates.at(-1)?.firewall.rules).toEqual(
          network === "all" ? [{ action: "allow", source: {}, destination: { public: true } }] : [],
        );
        expect(freestyleState.creates.at(-1)?.vpcs).toEqual([]);
      } finally {
        await box.destroy();
      }
    }
  });
  test("rejects sizes and hostname policies before allocating", async () => {
    const provider = factory();
    const count = freestyleState.creates.length;

    for (const opts of [
      { size: "small" },
      { size: { cpu: 1, memoryMb: 1024, diskGb: 10 } },
      { network: { allow: ["example.com"] } },
      { timeoutMs: 999 },
    ] satisfies Partial<Parameters<typeof provider.create>[0]>[])
      await expect(provider.create({ labels: {}, ...opts })).rejects.toMatchObject({
        code: "unsupported",
      });
    expect(freestyleState.creates.length).toBe(count);
  });
  test("limits round honestly and the service must confirm them", async () => {
    const box = await createSandbox(factory(), { timeoutMs: 2500, idleTimeoutMs: 1500 });

    try {
      expect(freestyleState.creates.at(-1)).toMatchObject({ ttlSeconds: 2, idleTimeoutSeconds: 2 });
    } finally {
      await box.destroy();
    }
  });
  test("unexpected firewall grants delete the VM and fail closed", async () => {
    const count = freestyleState.boxes.size;
    freestyleState.widen = true;

    try {
      await expect(createSandbox(factory(), { network: "none" })).rejects.toMatchObject({
        code: "unsupported",
      });
      expect(freestyleState.boxes.size).toBe(count);
    } finally {
      freestyleState.widen = false;
    }
  });
  test("late allocations after abort are destroyed", async () => {
    const controller = new AbortController();
    const count = freestyleState.boxes.size;
    freestyleState.delay = 80;
    const result = createSandbox(factory(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    try {
      await expect(result).rejects.toMatchObject({ code: "aborted" });
      await expect.poll(() => freestyleState.boxes.size, { timeout: 1000 }).toBe(count);
    } finally {
      freestyleState.delay = 0;
    }
  });
  test("secrets stay in private files and survive fresh-client reconnect", async () => {
    const box = await createSandbox(factory(), {
      secrets: { TOKEN: "freestyle-private-雪" },
      env: { HELLO: "world" },
    });

    try {
      expect((await box.run('test -n "$TOKEN" && echo "$HELLO"')).stdout).toBe("world\n");
      const fresh = await connectSandbox(factory(), box.id);
      expect((await fresh.run('test -n "$TOKEN" && echo "$HELLO"')).stdout).toBe("world\n");
      await fresh.close();
      const native = freestyleState.boxes.get(box.id);
      expect(native?.guest.commands.join("\n")).not.toContain("freestyle-private-雪");
      const { promises: fs } = await import("node:fs");

      if (!native) throw new Error("Missing mock VM");

      for (const path of ["/var/lib/sandbox-sdk.json", "/var/lib/sandbox-sdk-env.json"])
        expect((await fs.stat(native.guest.rewrite(path))).mode & 0o777).toBe(0o600);
    } finally {
      await box.destroy();
    }
  });
  test("buffered RPC responses stay bounded on large command output", async () => {
    const box = await createSandbox(factory());
    freestyleState.peak = 0;

    try {
      const result = await box.run("head -c 2000000 /dev/zero | tr '\\0' x; echo END", {
        maxOutputBytes: 128,
      });

      expect(result.truncated).toBe(true);
      expect(result.stdout).toContain("END");
      expect(freestyleState.peak).toBeLessThan(70000);
    } finally {
      await box.destroy();
    }
  });
  test("snapshots restore files with fresh SDK identity", async () => {
    const box = await createSandbox(factory(), { key: "original" });

    try {
      await box.files.write("saved", "hello");
      const snapshot = await box.snapshot();

      const copy = await createSandbox(factory(), {
        from: snapshot.id,
        key: "copy",
        network: "none",
      });

      try {
        expect(await copy.files.read("saved")).toBe("hello");
        expect(copy.key).toBe("copy");
        expect(copy.id).not.toBe(box.id);
      } finally {
        await copy.destroy();
      }
    } finally {
      await box.destroy();
    }
  });
  test("previews create inbound TLS rules with returned style.dev domains", async () => {
    const box = await createSandbox(factory());

    try {
      const preview = await box.preview(3000);
      expect(preview.url).toMatch(/^https:\/\/sdk-.*\.style\.dev$/);
      expect(freestyleState.rules.at(-1)).toMatchObject({
        domain: new URL(preview.url).hostname,
        source: { public: true },
        destination: { vmId: box.id, port: 3000 },
      });
      const before = freestyleState.rules.length;
      expect(await box.preview(3000)).toEqual(preview);
      expect(freestyleState.rules.length).toBe(before);
    } finally {
      await box.destroy();
    }
  });
  test("timeout and abort kill complete process groups", async () => {
    const box = await createSandbox(factory());

    try {
      expect(
        await box.run("(sleep .3; echo leaked > late) & wait", { timeoutMs: 40 }),
      ).toMatchObject({ timedOut: true });
      const c = new AbortController();

      const pending = Promise.resolve(
        box.run("(sleep .3; echo leaked > aborted) & wait", { signal: c.signal }),
      );

      setTimeout(() => c.abort(), 40);
      expect(await pending).toMatchObject({ timedOut: true });
      await new Promise((r) => setTimeout(r, 350));
      expect(await box.files.exists("late")).toBe(false);
      expect(await box.files.exists("aborted")).toBe(false);
    } finally {
      await box.destroy();
    }
  });
  test("HTTP errors lose native credentials and retain useful codes", () => {
    for (const [status, code] of [
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [429, "quota"],
      [503, "unavailable"],
      [400, "invalid_argument"],
      [408, "timeout"],
    ] as const) {
      const result = freestyleError(Object.assign(new Error("secret-native-error"), { status }));
      expect(result.code).toBe(code);
      expect(result.cause).toMatchObject({ status });
      expect(String(result)).not.toContain("secret-native-error");
    }
  });
});

import { cloudRegressions } from "./cloud-regressions.js";

cloudRegressions(
  () => {
    const provider = factory();
    const create = provider.create;
    provider.create = async (input) => {
      const info = await create(input);
      await provider.files.list(info.id, "/workspace");

      return info;
    };

    return provider;
  },
  (id) => freestyleState.boxes.get(id)?.guest,
);

test("unconfirmed process cancellation reports uncertainty without deleting a VM", async () => {
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");
  const exec = vi.spyOn(native, "exec");
  exec
    .mockRejectedValueOnce(new Error("transport lost"))
    .mockRejectedValueOnce(new Error("kill unconfirmed"));

  try {
    await expect(box.run("true")).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(freestyleState.boxes.has(box.id)).toBe(true);
  } finally {
    exec.mockRestore();
    await box.destroy();
  }
});

test("abort during native output paging stops all further reads", async () => {
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");
  const c = new AbortController();
  const read = native.fs.readFile.bind(native.fs);

  const spy = vi.spyOn(native.fs, "readFile").mockImplementationOnce(async (path, range) => {
    const result = await read(path, range);
    c.abort();

    return result;
  });

  try {
    expect(
      await box.run("head -c 2000000 /dev/zero | tr '\\0' x; echo END", { signal: c.signal }),
    ).toMatchObject({ timedOut: true, stdout: expect.stringContaining("END") });
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test("cancelled commands remove large output spools after killing the child group", async () => {
  const { promises: fs } = await import("node:fs");
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing VM");
  await box.run("true");
  const existing = new Set(await fs.readdir(native.guest.rewrite("/tmp/.sandbox-sdk")));

  try {
    expect(await box.run("head -c 2000000 /dev/zero; sleep 5", { timeoutMs: 150 })).toMatchObject({
      timedOut: true,
    });
    await expect
      .poll(
        async () =>
          (await fs.readdir(native.guest.rewrite("/tmp/.sandbox-sdk"))).filter(
            (n) => n.startsWith("run-") && !existing.has(n),
          ).length,
        { timeout: 500 },
      )
      .toBe(0);
  } finally {
    await box.destroy();
  }
});

test("run deadline can exceed the native request deadline", async () => {
  const box = await createSandbox(factory());
  await box.run("true");
  const provider = freestyle({ apiKey: "mock-key", requestTimeoutMs: 100 });

  try {
    const chunks: string[] = [];
    expect(
      await provider.exec(box.id, {
        command: "sleep .3; echo done",
        cwd: "/workspace",
        env: {},
        timeoutMs: 2000,
        onChunk: (c) => chunks.push(c.text),
      }),
    ).toMatchObject({ exitCode: 0, timedOut: false });
    expect(chunks.join("")).toBe("done\n");
  } finally {
    await box.destroy();
  }
});

for (const kind of ["timeout", "abort"] as const)
  test(`${kind} recovers captured buffered output in one cancellation call`, async () => {
    const box = await createSandbox(factory());
    const native = freestyleState.boxes.get(box.id);

    if (!native) throw new Error("Missing mock VM");
    const controller = new AbortController();
    const before = native.guest.commands.length;
    const reads = native.guest.reads.length;

    try {
      const pending = Promise.resolve(
        box.run("echo captured; echo diagnostic >&2; sleep 5", {
          timeoutMs: kind === "timeout" ? 300 : 5000,
          signal: controller.signal,
        }),
      );

      if (kind === "abort") setTimeout(() => controller.abort(), 300);
      expect(await pending).toMatchObject({
        timedOut: true,
        stdout: "captured\n",
        stderr: "diagnostic\n",
      });
      expect(native.guest.commands.length - before).toBe(2);
      expect(native.guest.reads.length - reads).toBe(0);
    } finally {
      await box.destroy();
    }
  });

test.each(["missing", "outdated"])(
  "legacy %s-version reconnects run inline without helper installation",
  async (version) => {
    const { promises: fs } = await import("node:fs");
    const { supervisorPath } = await import("../src/providers/freestyle/execute.js");
    const box = await createSandbox(factory());
    await box.run("true");
    const native = freestyleState.boxes.get(box.id);

    if (!native) throw new Error("Missing mock VM");

    try {
      const path = native.guest.rewrite("/var/lib/sandbox-sdk.json");
      await fs.writeFile(
        path,
        JSON.stringify({
          key: null,
          labels: box.labels,
          ...(version === "outdated" ? { supervisorHash: "old-version" } : {}),
        }),
      );
      await fs.rm(native.guest.rewrite(supervisorPath), { force: true });
      const provider = factory();
      const before = native.guest.commands.length;
      await Promise.all(Array.from({ length: 8 }, () => provider.connect(box.id)));
      expect(native.guest.commands.length - before).toBe(0);
      await fs.rm(native.guest.rewrite(supervisorPath), { force: true });
      const clients = Array.from({ length: 8 }, () => factory());

      // Warm the mocked dynamic import serially: Vitest can expose importActual
      // while its async mock factory is resolving concurrent imports.
      for (const client of clients) await client.list({});
      await Promise.all(clients.map((client) => client.connect(box.id)));
      expect((await box.run("echo ready")).stdout).toBe("ready\n");
    } finally {
      await box.destroy();
    }
  },
);

test("cancellation recovers a bounded tail and applies public output caps", async () => {
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");
  const before = native.guest.commands.length;
  freestyleState.peak = 0;

  try {
    const result = await box.run(
      "head -c 2000000 /dev/zero | tr '\\0' x; echo TAIL; echo ERROR >&2; sleep 5",
      { timeoutMs: 2000, maxOutputBytes: 128 },
    );

    expect(result).toMatchObject({ timedOut: true, truncated: true });
    expect(result.stdout).toContain("TAIL");
    expect(result.stderr).toContain("ERROR");
    expect(native.guest.commands.length - before).toBe(2);
    expect(freestyleState.peak).toBeLessThan(70000);
  } finally {
    await box.destroy();
  }
});

test("abort after supervisor completion recovers output before response delivery", async () => {
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");
  const controller = new AbortController();
  const original = native.exec.bind(native);

  const spy = vi.spyOn(native, "exec").mockImplementationOnce(async (options) => {
    await original(options);
    controller.abort();

    return new Promise(() => {});
  });

  const before = native.guest.commands.length;

  try {
    expect(await box.run("echo captured", { signal: controller.signal })).toMatchObject({
      timedOut: true,
      stdout: "captured\n",
    });
    expect(native.guest.commands.length - before).toBe(2);
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test("later commands amortize expired response cleanup without extra RPCs", async () => {
  const { promises: fs } = await import("node:fs");
  const { join } = await import("node:path");
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");

  try {
    await box.run("echo cached");
    const parent = native.guest.rewrite("/tmp/.sandbox-sdk");
    const old = (await fs.readdir(parent)).find((n) => n.startsWith("run-"));

    if (!old) throw new Error("No recovery spool");
    await fs.writeFile(join(parent, old, "expires"), "0");
    await box.run("true");
    expect((await fs.readdir(parent)).includes(old)).toBe(true);
    await fs.utimes(join(parent, ".sweep"), 0, 0);
    const before = native.guest.commands.length;
    await box.run("true");
    expect(native.guest.commands.length - before).toBe(1);
    expect((await fs.readdir(parent)).includes(old)).toBe(false);
  } finally {
    await box.destroy();
  }
});

test("paging cancellation preserves split UTF-8 characters across recovery", async () => {
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");
  const controller = new AbortController();
  const record = (bytes: Uint8Array) => ["stdout", Buffer.from(bytes).toString("hex")];

  const exec = vi
    .spyOn(native, "exec")
    .mockResolvedValueOnce({
      statusCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        result: { exitCode: 0, timedOut: false },
        chunks: [record(Buffer.from("a")), record(Buffer.from("b")), record(Uint8Array.of(0xe2))],
        offset: 123,
        size: 150,
      }),
    })
    .mockResolvedValueOnce({
      statusCode: 0,
      stderr: "",
      stdout: JSON.stringify({ chunks: [record(Uint8Array.of(0x82, 0xac))], offset: 123 }),
    });

  const read = vi.spyOn(native.fs, "readFile").mockImplementationOnce(async () => {
    controller.abort();

    return new Uint8Array();
  });

  try {
    expect(await box.run("true", { signal: controller.signal })).toMatchObject({
      timedOut: true,
      stdout: "ab€",
    });
  } finally {
    exec.mockRestore();
    read.mockRestore();
    await box.destroy();
  }
});

describe("Freestyle resilient discovery", () => {
  test("skips legacy missing, invalid and concurrently deleted metadata without hiding healthy VMs", async () => {
    const healthy = await createSandbox(factory(), { labels: { group: "list-regression" } });
    const damaged = await createSandbox(factory());

    try {
      const damagedVm = freestyleState.boxes.get(damaged.id);

      if (!damagedVm) throw new Error("Missing mock VM");
      delete damagedVm.record.metadata["sandbox-sdk-info"];

      for (const body of ["{", JSON.stringify({ key: null, labels: { bad: 2 } })]) {
        const read = vi.spyOn(damaged.native.fs, "readTextFile").mockResolvedValue(body);
        expect((await factory().list({})).map((v) => v.id)).toContain(healthy.id);
        expect((await factory().list({})).map((v) => v.id)).not.toContain(damaged.id);
        read.mockRestore();
      }

      for (const status of [404, 401, 503, 429]) {
        const read = vi
          .spyOn(damaged.native.fs, "readTextFile")
          .mockRejectedValue(Object.assign(new Error("native read"), { status }));

        if (status === 404)
          expect((await factory().list({})).map((v) => v.id)).toEqual([healthy.id]);
        else
          await expect(factory().list({})).rejects.toMatchObject({
            code: status === 401 ? "auth" : status === 503 ? "unavailable" : "quota",
          });
        read.mockRestore();
      }

      damagedVm.record.metadata = {};
      expect((await factory().list({})).map((v) => v.id)).toEqual([healthy.id]);
    } finally {
      await damaged.destroy();
      await healthy.destroy();
    }
  });
  test("surfaces native list failures even with an empty account", async () => {
    try {
      for (const [status, code] of [
        [401, "auth"],
        [503, "unavailable"],
        [429, "quota"],
      ] as const) {
        freestyleState.listError = status;
        await expect(factory().list({})).rejects.toMatchObject({ code });
      }
    } finally {
      freestyleState.listError = 0;
    }
  });
  test("native create metadata makes a pre-setup orphan reapable only by its own run", async () => {
    const run = "orphan-run-43";
    const box = await createSandbox(factory(), { labels: { "sandbox-bench-run": run } });

    try {
      const params = freestyleState.creates.at(-1);
      expect(params?.metadata?.["sandbox-sdk-info"]).toBeDefined();

      const read = vi
        .spyOn(box.native.fs, "readTextFile")
        .mockRejectedValue(Object.assign(new Error("missing marker"), { status: 404 }));

      const { listSandboxes, reapSandboxes } = await import("../src/index.js");
      expect(
        (await listSandboxes(factory(), { labels: { "sandbox-bench-run": run } })).map((v) => v.id),
      ).toEqual([box.id]);
      const connected = await connectSandbox(factory(), box.id);
      expect(connected.id).toBe(box.id);
      await connected.close();
      expect(
        await reapSandboxes(factory(), { labels: { "sandbox-bench-run": "another-run" } }),
      ).toBe(0);
      expect(await reapSandboxes(factory(), { labels: { "sandbox-bench-run": run } })).toBe(1);
      read.mockRestore();
    } finally {
      await box.destroy();
    }
  });
});

test("Freestyle native ownership fits the documented limits and rejects overflow before allocation", async () => {
  const provider = factory();

  const labels = {
    "sandbox-sdk": "1",
    unicode: "雪".repeat(200),
    "sandbox-bench-run": "chunked-run",
  };

  const box = await createSandbox(provider, { labels });

  try {
    const metadata = freestyleState.creates.at(-1)?.metadata ?? {};
    expect(Object.keys(metadata).length).toBeLessThanOrEqual(64);
    expect(
      Object.entries(metadata).every(([key, value]) => key.length <= 63 && value.length <= 63),
    ).toBe(true);
    expect(
      (await factory().list({ unicode: labels.unicode })).find((v) => v.id === box.id)?.labels,
    ).toEqual(labels);
    const before = freestyleState.creates.length;
    await expect(
      provider.create({ labels: { oversized: "x".repeat(4000) } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(freestyleState.creates.length).toBe(before);
  } finally {
    await box.destroy();
  }
});

test("current-version reconnect trusts the recorded supervisor without a guest RPC", async () => {
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");

  try {
    const before = native.guest.commands.length;
    const info = await factory().connect(box.id);
    expect(info.id).toBe(box.id);
    expect(native.guest.commands.length - before).toBe(0);
  } finally {
    await box.destroy();
  }
});

test("a missing installed helper does not add requests or replay the user command", async () => {
  const { promises: fs } = await import("node:fs");
  const { supervisorPath } = await import("../src/providers/freestyle/execute.js");
  const box = await createSandbox(factory());
  await box.run("true");
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");

  try {
    await fs.rm(native.guest.rewrite(supervisorPath), { force: true });
    const client = factory();
    const before = native.guest.commands.length;
    await client.connect(box.id);
    expect(native.guest.commands.length - before).toBe(0);
    const chunks: string[] = [];
    expect(
      await client.exec(box.id, {
        command: "echo once >> executions; echo ready",
        cwd: "/workspace",
        env: {},
        timeoutMs: 5000,
        onChunk: (c) => chunks.push(c.text),
      }),
    ).toMatchObject({ exitCode: 0 });
    expect(chunks.join("")).toBe("ready\n");
    expect(await fs.readFile(native.guest.rewrite("/workspace/executions"), "utf8")).toBe("once\n");
    expect(native.guest.commands.length - before).toBe(1);
    const next = native.guest.commands.length;
    expect(
      await client.exec(box.id, {
        command: "exit 2",
        cwd: "/workspace",
        env: {},
        timeoutMs: 5000,
        onChunk() {},
      }),
    ).toMatchObject({ exitCode: 2 });
    expect(native.guest.commands.length - next).toBe(1);
  } finally {
    await box.destroy();
  }
});

test("other supervisor failures never trigger installation or replay", async () => {
  const box = await createSandbox(factory());
  const native = freestyleState.boxes.get(box.id);

  if (!native) throw new Error("Missing mock VM");

  const exec = vi.spyOn(native, "exec").mockResolvedValueOnce({
    statusCode: 2,
    stdout: "",
    stderr:
      "python3: can't open file '/var/lib/sandbox-sdk-exec-v2.py': [Errno 13] Permission denied",
  });

  try {
    await expect(box.run("echo should-not-run")).rejects.toMatchObject({ code: "provider" });
    // One failed exec plus the existing cancellation/recovery RPC, no install.
    expect(exec).toHaveBeenCalledTimes(2);
  } finally {
    exec.mockRestore();
    await box.destroy();
  }
});

test("command shells restore SIGPIPE and use the supplied PATH", async () => {
  const box = await createSandbox(factory());

  try {
    expect(await box.run("kill -PIPE $$; echo survived")).toMatchObject({
      exitCode: 141,
      stdout: "",
    });
    const pipe = await box.run("yes | head -n 1");
    expect(pipe.stderr).toBe("");
    await box.files.write("shell-path/sh", '#!/bin/sh\nprintf selected >&2\nexec /bin/sh "$@"\n');
    await box.files.write("blocked-path/sh", "not executable");
    await box.run("chmod +x shell-path/sh");
    expect(
      await box.run("printf command", {
        env: { PATH: "/workspace/blocked-path:/workspace/shell-path" },
      }),
    ).toMatchObject({ stdout: "command", stderr: "selected", exitCode: 0 });
  } finally {
    await box.destroy();
  }
});

test("plain create has no guest call and first list prepares in one request", async () => {
  const box = await createSandbox(factory());
  const guest = freestyleState.boxes.get(box.id)?.guest;

  if (!guest) throw new Error("Missing guest");

  try {
    expect(guest.commands).toHaveLength(0);
    expect(await box.files.list(".")).toEqual([]);
    expect(guest.commands).toHaveLength(1);
    await box.run("rm -rf /workspace", { cwd: "/" });
    expect(await box.files.exists("/workspace")).toBe(false);
  } finally {
    await box.destroy();
  }
});

test("fresh client prepares a sandbox closed before first use", async () => {
  const box = await createSandbox(factory());
  const id = box.id;
  await box.close();
  const connected = await connectSandbox(factory(), id);

  try {
    expect(await connected.run("pwd")).toMatchObject({ stdout: "/workspace\n", exitCode: 0 });
  } finally {
    await connected.destroy();
  }
});

test("configured snapshots replace inherited identity and environment before reconnect", async () => {
  const source = await createSandbox(factory(), {
    key: "source",
    env: { SOURCE_ONLY: "source-value" },
  });

  try {
    const snapshot = await source.snapshot();
    const provider = freestyle({ apiKey: "mock-key", snapshotId: snapshot.id });
    const fresh = await createSandbox(provider, { labels: { identity: "fresh" } });
    await fresh.close();
    const connected = await connectSandbox(factory(), fresh.id);

    try {
      expect(connected.key).toBeUndefined();
      expect(connected.labels).toMatchObject({ identity: "fresh" });
      expect((await connected.run('printf %s "$SOURCE_ONLY"')).stdout).toBe("");
    } finally {
      await connected.destroy();
    }
  } finally {
    await source.destroy();
  }
});

test("first execution preserves the inherited umask", async () => {
  const box = await createSandbox(factory());

  try {
    const first = await box.run("umask");
    const second = await box.run("umask");
    expect(first.stdout).toBe(second.stdout);
  } finally {
    await box.destroy();
  }
});

describe("freestyle native options (SBX-71)", () => {
  test("files.write passes mode to the native write and keeps the native default otherwise", async () => {
    const provider = factory();
    expect(provider.files.writeSupportsMode).toBe(true);
    const box = await createSandbox(provider);

    try {
      await box.run("true");
      const native = freestyleState.boxes.get(box.id);

      if (!native) throw new Error("Missing mock VM");
      const write = vi.spyOn(native.fs, "writeFile");
      await box.files.write("secret", "x", { mode: 0o640 });
      await box.files.write("plain", "x");
      expect(write.mock.calls[0]?.[2]).toMatchObject({ mode: 0o640 });
      expect(write.mock.calls[1]?.[2]).not.toHaveProperty("mode");
      write.mockRestore();
    } finally {
      await box.destroy();
    }
  });
  test("the first-use write path applies mode in the guest", async () => {
    const box = await createSandbox(factory());

    try {
      const native = freestyleState.boxes.get(box.id);

      if (!native) throw new Error("Missing mock VM");
      const write = vi.spyOn(native.fs, "writeFile");
      await box.files.write("first", "x", { mode: 0o751 });
      await box.files.write("second", "x");
      expect(write).toHaveBeenCalledTimes(1);
      write.mockRestore();
      const { promises: fs } = await import("node:fs");
      expect((await fs.stat(native.guest.rewrite("/workspace/first"))).mode & 0o777).toBe(0o751);
    } finally {
      await box.destroy();
    }
  });
  test("snapshot expiresInMs maps to ttlSeconds; 0 keeps the snapshot", async () => {
    const provider = factory();
    const box = await createSandbox(provider);

    try {
      freestyleState.snapshotOptions.length = 0;
      await box.snapshot({ expiresInMs: 90_500 });
      await box.snapshot({ expiresInMs: 0 });
      await box.snapshot();
      expect(freestyleState.snapshotOptions).toEqual([{ ttlSeconds: 91 }, undefined, undefined]);
      await expect(box.snapshot({ expiresInMs: -1 })).rejects.toMatchObject({
        code: "invalid_argument",
      });
    } finally {
      await box.destroy();
    }
  });
  test("autoDeleteMs reaches vms.create in seconds and is confirmed", async () => {
    const provider = freestyle({ apiKey: "mock-key", autoDeleteMs: 0 });
    const box = await provider.create({ labels: {} });

    try {
      expect(freestyleState.creates.at(-1)).toMatchObject({ autoDeleteSeconds: 0 });
    } finally {
      await provider.destroy(box.id);
    }

    const later = freestyle({ apiKey: "mock-key", autoDeleteMs: 3_600_001 });
    const second = await later.create({ labels: {} });

    try {
      expect(freestyleState.creates.at(-1)).toMatchObject({ autoDeleteSeconds: 3601 });
    } finally {
      await later.destroy(second.id);
    }

    expect(() => freestyle({ autoDeleteMs: -1 })).toThrowError(
      expect.objectContaining({ code: "invalid_argument" }),
    );
  });
});

test("a missing file is file_not_found for read, edit and remove, like the other providers", async () => {
  const box = await createSandbox(factory());

  try {
    await box.run("true");

    for (const action of [
      () => box.files.read("missing.txt"),
      () => box.files.edit("missing.txt", { find: "a", replace: "b" }),
      () => box.files.remove("missing.txt"),
    ])
      await expect(action()).rejects.toMatchObject({
        code: "file_not_found",
        provider: "freestyle",
      });
  } finally {
    await box.destroy();
  }
});

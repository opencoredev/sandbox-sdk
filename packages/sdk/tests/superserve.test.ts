import { afterAll, describe, expect, expectTypeOf, test, vi } from "vitest";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quote } from "../src/shared/shell.js";
import {
  activations,
  api,
  dataHost,
  dataRequests,
  gate,
  installSuperserveFake,
  resetSuperserveFake,
  revoke,
  state,
  tokenOf,
} from "./superserve-fake.js";

installSuperserveFake();

import {
  superserve,
  type SuperserveNative,
  type SuperserveProvider,
} from "../src/providers/superserve/index.js";
import { superserveError } from "../src/providers/superserve/errors.js";
import { createSandbox, connectSandbox, SandboxError } from "../src/index.js";
import { runConformance } from "../src/testing.js";

const factory = () => superserve({ apiKey: "mock" });

// live: true authorizes the fake: every request goes to the local Superserve API.
runConformance(factory, {
  live: true,
  unsupported: {
    httpProbe: "Mock superserve preview URLs point at an unreachable host",
    gitPush: "The HTTP fake's guest has no git identity; the live smoke covers git on superserve",
  },
});

afterAll(async () => {
  await resetSuperserveFake();
  vi.unstubAllGlobals();
});

test("fails closed before allocation for unsupported creation settings", async () => {
  const p = factory(),
    before = state.creates;

  for (const options of [
    { size: "small" },
    { size: { cpu: 1, memoryMb: 1024, diskGb: 4 } },
    { network: { allow: ["https://example.com"] } },
    { network: { allow: ["example.com:443"] } },
    { timeoutMs: 1000 },
    { idleTimeoutMs: 1000 },
  ] satisfies Partial<Parameters<typeof p.create>[0]>[])
    await expect(p.create({ labels: {}, ...options })).rejects.toMatchObject({
      code: "unsupported",
    });
  expect(state.creates).toBe(before);
});

test("maps statuses without retaining native secrets", () => {
  for (const [statusCode, code] of [
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "quota"],
    [503, "unavailable"],
    [504, "timeout"],
    [422, "invalid_argument"],
  ] as const) {
    const error = superserveError(Object.assign(new Error("secret-api-key"), { statusCode }));
    expect(error.code).toBe(code);
    // An HTTP failure keeps its name and status as cause, never the response text.
    expect(error.cause).toBe(`Error HTTP ${statusCode}`);
    expect(String(error)).not.toContain("secret-api-key");
  }
});

test("transport failure confirms termination before a delayed side effect", async () => {
  const box = await createSandbox(factory());

  try {
    state.transportFailure = true;
    // The connection drops after the command started, so the run's outcome is unknown, never a plain failure.
    await expect(box.run("sleep .4; echo leaked > late-transport")).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(await box.files.exists("late-transport")).toBe(false);
    expect((await box.run("echo usable")).stdout).toBe("usable\n");
  } finally {
    await box.destroy();
  }
});

test("creation defers bootstrap to the first execution", async () => {
  let calls = 0;
  state.bootstrap = async () => {
    calls++;
  };

  const box = await createSandbox(factory());

  try {
    expect(calls).toBe(0);
    expect((await box.run("true")).ok).toBe(true);
    expect(calls).toBe(1);
    expect((await box.run("true")).ok).toBe(true);
    expect(calls).toBe(1);
  } finally {
    state.bootstrap = undefined;
    await box.destroy();
  }
});

test("snapshot failures retain a safe idempotent recovery name", async () => {
  const box = await createSandbox(factory());

  try {
    expect(await box.snapshot()).toEqual({ id: "snapshot-1" });
    expect(state.snapshotOptions).toMatchObject({
      name: expect.stringMatching(/^sbxsdk-/),
      idempotency_key: expect.any(String),
    });
    state.snapshotFailure = true;
    await expect(box.snapshot()).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringContaining("recover snapshot named sbxsdk-"),
    });
  } finally {
    state.snapshotFailure = false;
    await box.destroy();
  }
});

test("stdin setup failure closes the native session", async () => {
  const box = await createSandbox(factory());

  try {
    const before = state.closes;
    state.stdinFailure = true;
    await expect(box.run("cat", { stdin: "private-input" })).rejects.toMatchObject({
      code: "provider",
    });
    expect(state.closes).toBeGreaterThan(before);
  } finally {
    state.stdinFailure = false;
    await box.destroy();
  }
});

test("a range read does not download the full native file", async () => {
  const provider = factory(),
    box = await createSandbox(provider);

  try {
    await box.files.write("range.bin", new Uint8Array([0, 1, 2, 3, 4, 5]));
    const guest = state.boxes.get(box.id)?.guest;

    if (!guest) throw new Error("missing guest");
    const before = guest.reads.length;
    expect(
      await provider.files.readRange?.(box.id, "/workspace/range.bin", { offset: 2, length: 3 }),
    ).toEqual(new Uint8Array([2, 3, 4]));
    expect(guest.reads.length).toBe(before);
  } finally {
    await box.destroy();
  }
});

test.each([
  [undefined, "superserve/node-22"],
  ["sandbox-bench-node22-py311-1x1", "sandbox-bench-node22-py311-1x1"],
  ["93d75667-9e61-4d93-b8f8-2b5beac98fca", "93d75667-9e61-4d93-b8f8-2b5beac98fca"],
])("selects template %s without changing the provider default", async (template, expected) => {
  const provider = superserve({ apiKey: "mock", template });
  const box = await provider.create({ labels: {} });

  try {
    expect(state.createOptions).toMatchObject({ from_template: expected });
    expect(state.createOptions).not.toHaveProperty("from_snapshot");
  } finally {
    await provider.destroy(box.id);
  }
});

test("snapshot restore takes precedence over a custom template", async () => {
  const provider = superserve({ apiKey: "mock", template: "sandbox-bench-node22-py311-1x1" });
  const box = await provider.create({ labels: {}, from: "snapshot-custom" });

  try {
    expect(state.createOptions).toMatchObject({ from_snapshot: "snapshot-custom" });
    expect(state.createOptions).not.toHaveProperty("from_template");
  } finally {
    await provider.destroy(box.id);
  }
});

test("first execution prepares the environment and launcher in its single guest call", async () => {
  const provider = factory();
  const before = state.updates.length;
  const value = "literal'$(echo injected)";
  const box = await provider.create({ labels: {}, env: { LITERAL: value } });

  try {
    const guest = state.boxes.get(box.id)?.guest;

    if (!guest) throw new Error("missing guest");
    expect(guest.commands).toHaveLength(0);
    expect(guest.uploads).toHaveLength(0);
    expect(state.updates).toHaveLength(before);
    const chunks: string[] = [];
    expect(
      await provider.exec(box.id, {
        command: `printf '%s' "$LITERAL"`,
        cwd: "/workspace",
        env: {},
        timeoutMs: 10000,
        onChunk: (chunk) => chunks.push(chunk.text),
      }),
    ).toMatchObject({ exitCode: 0, timedOut: false });
    expect(chunks.join("")).toBe(value);
    expect(guest.commands).toHaveLength(1);
  } finally {
    await provider.destroy(box.id);
  }
});

test("restores clear an inherited auto-pause timeout", async () => {
  const provider = factory();
  const before = state.updates.length;
  state.nativeTimeoutSeconds = 60;

  try {
    const box = await provider.create({ labels: {}, from: "external-snapshot" });

    try {
      expect(state.updates.slice(before)).toEqual([{ timeout_seconds: null }]);
    } finally {
      await provider.destroy(box.id);
    }
  } finally {
    state.nativeTimeoutSeconds = 0;
  }
});

test("missing Python fails on first use without running apt", async () => {
  const path = await mkdtemp(join(tmpdir(), "superserve-no-python-"));
  state.bootstrapPath = path;
  const provider = factory();
  const box = await provider.create({ labels: {} });

  try {
    await expect(provider.files.list(box.id, "/workspace")).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("explicitly set installPython: true"),
    });
  } finally {
    state.bootstrapPath = "";
    await provider.destroy(box.id);
    await rm(path, { recursive: true, force: true });
  }
});

test("missing Python on a first run reports unsupported, not an unconfirmed cancellation", async () => {
  const path = await mkdtemp(join(tmpdir(), "superserve-no-python-run-"));
  state.bootstrapPath = path;
  const box = await createSandbox(factory());

  try {
    await expect(box.run("echo ok")).rejects.toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("explicitly set installPython: true"),
    });
  } finally {
    state.bootstrapPath = "";
    await box.destroy();
    await rm(path, { recursive: true, force: true });
  }
});

test("only an explicit installPython opt-in runs apt when Python is absent", async () => {
  const path = await mkdtemp(join(tmpdir(), "superserve-opt-in-"));
  const log = join(path, "apt.log");

  for (const tool of ["git", "tar", "nohup"]) await symlink(`/usr/bin/${tool}`, join(path, tool));
  await writeFile(
    join(path, "apt-get"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(log)}
if [ "$1" = install ]; then /usr/bin/ln -s /usr/bin/python3 ${quote(join(path, "python3"))}; fi
`,
    { mode: 0o700 },
  );
  state.bootstrapPath = path;
  const provider = superserve({ apiKey: "mock", installPython: true });

  try {
    const box = await provider.create({ labels: {} });

    try {
      await provider.files.list(box.id, "/workspace");
      expect(await readFile(log, "utf8")).toBe(
        "update -qq\ninstall -y -qq python3 python3-venv python3-pip\n",
      );
    } finally {
      await provider.destroy(box.id);
    }
  } finally {
    state.bootstrapPath = "";
    await rm(path, { recursive: true, force: true });
  }
});

test("one-shot execution keeps env values out of argv and preserves stdin sessions", async () => {
  const box = await createSandbox(factory());

  try {
    const secret = "private-command-secret";

    const probe = await box.run(
      'python3 -c \'import os; print(open("/proc/%s/cmdline" % os.getppid(), "rb").read().decode()); print(os.environ["TOKEN"])\'',
      { env: { TOKEN: secret } },
    );

    expect(probe.stdout.trim().split("\n").at(-1)).toBe(secret);
    expect(probe.stdout.slice(0, probe.stdout.lastIndexOf(secret))).not.toContain(secret);
    expect((await box.run("cat", { stdin: secret })).stdout).toBe(secret);
  } finally {
    await box.destroy();
  }
});

test("quote-heavy commands use stdin transport before shell argument expansion exceeds its limit", async () => {
  const box = await createSandbox(factory());

  try {
    expect(await box.run(": #" + "'".repeat(40_000))).toMatchObject({ exitCode: 0 });
  } finally {
    await box.destroy();
  }
});

test("fresh files prepare the workspace before execution", async () => {
  const provider = factory();
  const box = await createSandbox(provider);

  try {
    const guest = state.boxes.get(box.id)?.guest;

    if (!guest) throw new Error("Missing guest");
    expect(guest.commands).toHaveLength(0);
    expect(await box.files.list(".")).toEqual([]);
    expect((await box.files.stat(".")).type).toBe("directory");
    await box.files.write("nested/first.bin", new Uint8Array([0, 255, 10]));
    expect(await box.files.read("nested/first.bin", { as: "bytes" })).toEqual(
      new Uint8Array([0, 255, 10]),
    );
    expect(
      (await Promise.all([box.run("echo one"), box.run("echo two")])).map((x) => x.stdout),
    ).toEqual(["one\n", "two\n"]);
  } finally {
    await box.destroy();
  }
});

test("an empty create environment clears an inherited snapshot env file", async () => {
  const box = await createSandbox(factory());

  try {
    const guest = state.boxes.get(box.id)?.guest;

    if (!guest) throw new Error("Missing guest");
    await guest.upload(
      "/var/lib/sandbox-sdk-env.json",
      Buffer.from('{"STALE_SNAPSHOT_ENV":"stale"}'),
    );
    expect((await box.run('printf %s "$STALE_SNAPSHOT_ENV"')).stdout).toBe("");
  } finally {
    await box.destroy();
  }
});

test("first file operation persists create environment for a fresh client", async () => {
  const box = await createSandbox(factory(), { env: { FIRST_FILE_ENV: "persisted" } });

  try {
    await box.files.list(".");
    const reconnected = await connectSandbox(factory(), box.id);

    try {
      expect((await reconnected.run('printf %s "$FIRST_FILE_ENV"')).stdout).toBe("persisted");
    } finally {
      await reconnected.close();
    }
  } finally {
    await box.destroy();
  }
});

test("native lifetime, secret and preview options reach POST /sandboxes in seconds", async () => {
  const provider = superserve({
    apiKey: "mock",
    autoPauseMs: 90_500,
    autoDeleteMs: 0,
    secretBindings: { OPENAI_API_KEY: "openai-prod" },
    previewAccess: "public",
  });

  const box = await provider.create({ labels: {} });

  try {
    expect(state.createOptions).toMatchObject({
      timeout_seconds: 91,
      auto_delete_seconds: 0,
      secrets: { OPENAI_API_KEY: "openai-prod" },
      preview_access: "public",
    });
    expect(state.createOptions).not.toHaveProperty("network");
    expect(await provider.previewUrl(box.id, 3000)).toEqual({
      url: `https://3000-${box.id}.sandbox.superserve.ai`,
    });
    expect(state.previewAccess.at(-1)).toEqual({ port: 3000, access: "public" });
  } finally {
    await provider.destroy(box.id);
  }

  expect(() => superserve({ autoPauseMs: 0 })).toThrowError(
    expect.objectContaining({ code: "invalid_argument" }),
  );
  expect(() => superserve({ autoDeleteMs: -1 })).toThrowError(
    expect.objectContaining({ code: "invalid_argument" }),
  );
});

test("network policy maps to Superserve egress rules and is confirmed after create", async () => {
  const provider = factory();
  expect(provider.capabilities.has("network-policy")).toBe(true);

  const cases: [import("../src/provider.js").CreateInput["network"], unknown][] = [
    ["none", { allow_out: [], deny_out: ["0.0.0.0/0"] }],
    [
      { allow: ["10.0.0.0/8", "1.2.3.4"] },
      { allow_out: ["10.0.0.0/8", "1.2.3.4/32"], deny_out: ["0.0.0.0/0"] },
    ],
    [
      { allow: ["registry.npmjs.org", "*.github.com"] },
      {
        allow_out: ["registry.npmjs.org", "*.github.com", "1.1.1.1/32", "8.8.8.8/32"],
        deny_out: ["0.0.0.0/0"],
      },
    ],
  ];

  for (const [network, expected] of cases) {
    const box = await provider.create({ labels: {}, network });

    try {
      expect(state.createOptions).toMatchObject({ network: expected });
    } finally {
      await provider.destroy(box.id);
    }
  }

  state.dropNetwork = true;
  const before = state.boxes.size;

  try {
    await expect(provider.create({ labels: {}, network: "none" })).rejects.toMatchObject({
      code: "unsupported",
    });
  } finally {
    state.dropNetwork = false;
  }

  expect(state.boxes.size).toBe(before);
});

test("restores apply the configured auto-pause instead of the inherited one", async () => {
  const provider = superserve({ apiKey: "mock", autoPauseMs: 30_000 });
  const before = state.updates.length;
  state.nativeTimeoutSeconds = 60;

  try {
    const box = await provider.create({ labels: {}, from: "external-snapshot" });

    try {
      expect(state.createOptions).toMatchObject({
        from_snapshot: "external-snapshot",
        timeout_seconds: 30,
      });
      expect(state.updates.slice(before)).toEqual([{ timeout_seconds: 30 }]);
    } finally {
      await provider.destroy(box.id);
    }
  } finally {
    state.nativeTimeoutSeconds = 0;
  }
});

test("snapshot rejects expiresInMs because Superserve keeps snapshots until deleted", async () => {
  const provider = factory();
  const box = await provider.create({ labels: {} });

  try {
    state.snapshotOptions = undefined;
    await expect(provider.snapshot?.(box.id, { expiresInMs: 3_600_000 })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(state.snapshotOptions).toBeUndefined();
    expect(await provider.snapshot?.(box.id, { expiresInMs: 0 })).toEqual({ id: "snapshot-1" });
  } finally {
    await provider.destroy(box.id);
  }
});

test("a missing cwd is a failed run with the shell error on stderr, and start reports it in the log", async () => {
  const box = await createSandbox(factory());

  try {
    expect(await box.run("pwd", { cwd: "nope" })).toMatchObject({
      ok: false,
      exitCode: 2,
      stdout: "",
      stderr: expect.stringMatching(/cd.*nope/),
    });
    const started = await box.start("sleep 30", { name: "bad-cwd", cwd: "nope" });
    await expect(started.wait()).resolves.toMatchObject({ exitCode: 2 });
    expect((await started.logs()).text).toMatch(/cd.*nope/);
    expect((await box.run("echo alive")).stdout).toBe("alive\n");
  } finally {
    await box.destroy();
  }
});

describe("data-plane routes", () => {
  const read = (provider: ReturnType<typeof factory>, id: string) =>
    provider.files.read(id, "/workspace/route.txt");

  async function created(provider = factory()) {
    const info = await provider.create({ labels: {} });
    await state.boxes
      .get(info.id)
      ?.guest.upload("/workspace/route.txt", new TextEncoder().encode("ok"));

    return { provider, id: info.id };
  }

  test("data-plane calls send the sandbox id, access token and routing hint only to the data host", async () => {
    const { provider, id } = await created();

    try {
      expect(new TextDecoder().decode(await read(provider, id))).toBe("ok");
      const [request] = dataRequests(id);
      expect(request?.url.href).toBe(`${dataHost}/files?path=%2Fworkspace%2Froute.txt`);
      expect(request?.headers.get("x-access-token")).toBe(tokenOf(id));
      expect(request?.headers.get("x-superserve-routing-hint")).toMatch(/^eyJ/);
      expect(request?.headers.get("x-api-key")).toBeNull();
      const control = state.requests.filter((r) => r.url.origin === api);
      expect(
        control.every(
          (r) => r.headers.get("x-access-token") === null && r.headers.get("x-api-key") === "mock",
        ),
      ).toBe(true);
      expect(activations(id)).toBe(0);
    } finally {
      await provider.destroy(id);
    }
  });

  test("a routing hint about to expire is replaced before the call, not after a failure", async () => {
    state.hintSeconds = 10;
    const { provider, id } = await created();
    state.hintSeconds = 3600;

    try {
      const before = state.requests.length;
      await read(provider, id);

      const after = state.requests
        .slice(before)
        .map((r) => `${r.method} ${r.url.origin === api ? "api" : "data"}${r.url.pathname}`);

      expect(after).toEqual([`POST api/sandboxes/${id}/activate`, "GET data/files"]);
      // The fresh hint is good for an hour, so the next call needs no activation.
      await read(provider, id);
      expect(activations(id)).toBe(1);
    } finally {
      await provider.destroy(id);
    }
  });

  test.each([
    ["a 401", { status: 401, body: { error: "invalid access token" } }],
    [
      "a stale-route 404",
      { status: 404, body: { error: { code: "sandbox_route_stale", message: "moved" } } },
    ],
    [
      "a 503 sandbox_unavailable",
      { status: 503, body: { error: { code: "sandbox_unavailable", message: "paused" } } },
    ],
    ["the legacy plain-text paused 503", { status: 503, body: "sandbox is paused\n" }],
  ])("%s reactivates once and resends", async (_name, fault) => {
    const { provider, id } = await created();

    try {
      state.dataFaults.push(fault);
      expect(new TextDecoder().decode(await read(provider, id))).toBe("ok");
      expect(activations(id)).toBe(1);
      expect(dataRequests(id)).toHaveLength(2);
    } finally {
      state.dataFaults = [];
      await provider.destroy(id);
    }
  });

  test("a hinted 503 without sandbox_unavailable and a plain 404 do not reactivate", async () => {
    const { provider, id } = await created();

    try {
      state.dataFaults.push({
        status: 503,
        body: { error: { code: "overloaded", message: "busy" } },
      });
      expect(new TextDecoder().decode(await read(provider, id))).toBe("ok");
      expect(activations(id)).toBe(0);
      await expect(provider.files.read(id, "/workspace/missing")).rejects.toMatchObject({
        code: "file_not_found",
      });
      expect(activations(id)).toBe(0);
    } finally {
      state.dataFaults = [];
      await provider.destroy(id);
    }
  });

  test("without a routing hint a bare 503 reactivates; a read is resent, an exec that may have run is not", async () => {
    state.noHints = true;
    const { provider, id } = await created();

    const execs = () =>
      state.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.url.origin === dataHost &&
          request.url.pathname === "/exec",
      );

    try {
      expect(dataRequests(id).at(-1)?.headers.get("x-superserve-routing-hint") ?? null).toBeNull();
      state.dataFaults.push({
        status: 503,
        body: { error: { code: "overloaded", message: "busy" } },
      });
      expect(new TextDecoder().decode(await read(provider, id))).toBe("ok");
      expect(activations(id)).toBe(1);
      expect(dataRequests(id)).toHaveLength(2);
      const box = await connectSandbox(provider, id);
      const before = execs().length;
      state.dataFaults.push({
        status: 503,
        body: { error: { code: "overloaded", message: "busy" } },
      });
      await expect(box.run("echo once >> ran.txt")).rejects.toMatchObject({
        code: "outcome_unknown",
        provider: "superserve",
      });
      // The refused launch went out once: a second copy could run the command twice. (A later /exec is the
      // supervisor's own recovery check, a different command.) The route was still refreshed for the next call.
      const launch = JSON.stringify(execs()[before]?.body);
      expect(
        execs()
          .slice(before)
          .filter((request) => JSON.stringify(request.body) === launch),
      ).toHaveLength(1);
      expect(activations(id)).toBe(2);
    } finally {
      state.noHints = false;
      state.dataFaults = [];
      await provider.destroy(id);
    }
  });

  test("a second refusal after reactivating fails instead of looping", async () => {
    const { provider, id } = await created();

    try {
      state.dataFaults.push({ status: 401, body: {} }, { status: 401, body: {} });
      await expect(read(provider, id)).rejects.toMatchObject({
        code: "auth",
        provider: "superserve",
      });
      expect(activations(id)).toBe(1);
    } finally {
      state.dataFaults = [];
      await provider.destroy(id);
    }
  });

  test("concurrent calls refused at once share one activation", async () => {
    const { provider, id } = await created();

    try {
      revoke(id);
      const held = gate();
      state.activateGate = held.promise;
      const reads = Array.from({ length: 6 }, () => read(provider, id));
      // Every read is refused and waits on the single activation the first one started.
      await vi.waitFor(() => expect(dataRequests(id)).toHaveLength(6));
      await vi.waitFor(() => expect(activations(id)).toBe(1));
      held.open();
      expect((await Promise.all(reads)).map((bytes) => new TextDecoder().decode(bytes))).toEqual(
        Array(6).fill("ok"),
      );
      expect(activations(id)).toBe(1);
    } finally {
      state.activateGate = undefined;
      await provider.destroy(id);
    }
  });

  test("an activation that answers after a newer resume never replaces the resumed token", async () => {
    const { provider, id } = await created();

    try {
      revoke(id);
      const held = gate();
      state.activateGate = held.promise;
      // The refused read starts an activation; the server mints its answer now and holds it.
      const pending = read(provider, id);
      await vi.waitFor(() => expect(activations(id)).toBe(1));
      // A resume starts later, rotates the token on the server and answers first.
      await provider.resume?.(id);
      const resumed = tokenOf(id);
      held.open();
      expect(new TextDecoder().decode(await pending)).toBe("ok");
      // The refused read was resent with the resumed token, and so is the next read: the held answer was dropped.
      expect(dataRequests(id).at(-1)?.headers.get("x-access-token")).toBe(resumed);
      await read(provider, id);
      expect(dataRequests(id).map((r) => r.headers.get("x-access-token") === resumed)).toEqual([
        false,
        true,
        true,
      ]);
      expect(activations(id)).toBe(1);
    } finally {
      state.activateGate = undefined;
      await provider.destroy(id);
    }
  });

  test("a refusal sent with a token older than the current one resends without activating", async () => {
    const { provider, id } = await created();

    try {
      revoke(id);
      const held = gate();
      state.dataGate = held.promise;
      // The read goes out with the revoked token; the server decides on a 401 and holds it.
      const pending = read(provider, id);
      await vi.waitFor(() => expect(dataRequests(id)).toHaveLength(1));
      state.dataGate = undefined;
      // A resume answers meanwhile with a newer token.
      await provider.resume?.(id);
      held.open();
      expect(new TextDecoder().decode(await pending)).toBe("ok");
      expect(activations(id)).toBe(0);
      expect(dataRequests(id).map((r) => r.headers.get("x-access-token") === tokenOf(id))).toEqual([
        false,
        true,
      ]);
    } finally {
      state.dataGate = undefined;
      await provider.destroy(id);
    }
  });

  test("an aborted caller leaves the shared activation running for the others", async () => {
    const { provider, id } = await created();

    try {
      revoke(id);
      const held = gate();
      state.activateGate = held.promise;
      const controller = new AbortController();
      const native = provider.native(id);

      const abandoned = native.fetch("GET", "/files", {
        plane: "data",
        query: { path: "/workspace/route.txt" },
        signal: controller.signal,
      });

      const kept = read(provider, id);
      await vi.waitFor(() => expect(activations(id)).toBe(1));
      controller.abort();
      await expect(abandoned).rejects.toMatchObject({ code: "aborted" });
      held.open();
      expect(new TextDecoder().decode(await kept)).toBe("ok");
      expect(activations(id)).toBe(1);
    } finally {
      state.activateGate = undefined;
      await provider.destroy(id);
    }
  });
});

describe("exec/connect", () => {
  test("stdin runs dial the per-sandbox host with the token and hint as subprotocols", async () => {
    const box = await createSandbox(factory());

    try {
      const before = state.sockets.length;
      expect((await box.run("cat", { stdin: "über-stdin" })).stdout).toBe("über-stdin");
      const socket = state.sockets[before];
      expect(socket?.url).toBe(`wss://boxd-${box.id}.sandbox.superserve.ai/exec/connect`);
      expect(socket?.protocols).toEqual([
        "superserve.exec.v1",
        `token.${tokenOf(box.id)}`,
        expect.stringMatching(/^route\.eyJ/),
      ]);
      const start = JSON.parse(String(socket?.sent[0]));
      expect(start).toMatchObject({ command: expect.any(String), timeout_s: expect.any(Number) });
      // Start, stdin frames on channel 0, stdin_close, then the SIGTERM that closing a finished session sends.
      const close = socket?.sent.indexOf(JSON.stringify({ type: "stdin_close" })) ?? -1;
      expect(close).toBeGreaterThan(1);
      expect(
        socket?.sent
          .slice(1, close)
          .every(
            (frame) =>
              frame instanceof Uint8Array && frame[0] === 0 && frame.length <= 32 * 1024 + 1,
          ),
      ).toBe(true);
      expect(socket?.sent.slice(close + 1)).toEqual([
        JSON.stringify({ type: "signal", name: "SIGTERM" }),
      ]);
    } finally {
      await box.destroy();
    }
  });

  test("a refused dial reactivates once and dials again", async () => {
    const box = await createSandbox(factory());

    try {
      const before = state.sockets.length;
      state.refuseDials = 1;
      expect((await box.run("cat", { stdin: "again" })).stdout).toBe("again");
      expect(state.sockets.length - before).toBe(2);
      expect(activations(box.id)).toBe(1);
      state.refuseDials = 2;
      await expect(box.run("cat", { stdin: "never" })).rejects.toBeInstanceOf(SandboxError);
    } finally {
      state.refuseDials = 0;
      await box.destroy();
    }
  });

  test("an expiring hint is replaced before dialling", async () => {
    state.hintSeconds = 5;
    const box = await createSandbox(factory());
    state.hintSeconds = 3600;

    try {
      const before = state.requests.length;
      expect((await box.run("cat", { stdin: "fresh" })).stdout).toBe("fresh");
      expect(state.requests.slice(before)[0]?.url.pathname).toBe(`/sandboxes/${box.id}/activate`);
    } finally {
      await box.destroy();
    }
  });

  test("an abort before the dial opens rejects without starting the command", async () => {
    const provider = factory();
    const box = await provider.create({ labels: {} });

    try {
      const controller = new AbortController();
      controller.abort();
      expect(
        await provider.exec(box.id, {
          command: "echo never",
          cwd: "/workspace",
          env: {},
          stdin: "x",
          timeoutMs: 5000,
          signal: controller.signal,
          onChunk: () => {},
        }),
      ).toEqual({ exitCode: null, timedOut: true });
    } finally {
      await provider.destroy(box.id);
    }
  });
});

describe("native API", () => {
  test("box.native fills {sandboxId} on the control plane and routes the data plane", async () => {
    const box = await createSandbox(factory());

    try {
      expect(box.native.sandboxId).toBe(box.id);
      expect(
        await box.native.request<{ id: string; status: string }>("GET", "/sandboxes/{sandboxId}"),
      ).toMatchObject({ id: box.id, status: "active" });
      await box.files.write("native.txt", "native");

      const response = await box.native.fetch("GET", "/files", {
        plane: "data",
        query: { path: "/workspace/native.txt" },
      });

      expect(await response.text()).toBe("native");
      await expect(box.native.request("GET", "/no/such/route")).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await box.destroy();
    }
  });

  test("provider.api is account scoped: no sandbox placeholder, no data plane", async () => {
    const provider = factory();
    const box = await provider.create({ labels: { native: "api" } });

    try {
      expect(provider.api.sandboxId).toBeUndefined();

      const list = await provider.api.request<{ id: string }[]>("GET", "/sandboxes", {
        query: { "metadata.sandbox-sdk": "1" },
      });

      expect(list.map((v) => v.id)).toContain(box.id);
      const before = state.requests.length;
      await expect(provider.api.request("GET", "/sandboxes/{sandboxId}")).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(provider.api.request("GET", "/files", { plane: "data" })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      expect(state.requests.length).toBe(before);
    } finally {
      await provider.destroy(box.id);
    }
  });

  test("sdk(load) connects the caller's Sandbox class with this provider's credentials", async () => {
    const calls: unknown[][] = [];

    class Sandbox {
      constructor(readonly id: string) {}
      static async connect(id: string, options?: { apiKey?: string; baseUrl?: string }) {
        calls.push([id, options]);

        return new Sandbox(id);
      }
    }

    const provider = superserve({ apiKey: "mock" });
    const native = provider.native("sb-1");
    const connected = await native.sdk(async () => ({ Sandbox }));
    expectTypeOf(connected).toEqualTypeOf<Sandbox>();
    expect(connected.id).toBe("sb-1");
    expect(calls).toEqual([["sb-1", { apiKey: "mock", baseUrl: undefined }]]);
    const account = await provider.api.sdk(async () => ({ Sandbox }));
    expectTypeOf(account).toEqualTypeOf<typeof Sandbox>();
    expect(account).toBe(Sandbox);

    // JavaScript callers can hand over anything; a module without Sandbox is invalid_argument.
    const wrong: Promise<unknown> = Reflect.apply(native.sdk, undefined, [
      async () => ({ Other: 1 }),
    ]);

    await expect(wrong).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      native.sdk(() =>
        Promise.reject(
          Object.assign(new Error("Cannot find package '@superserve/sdk'"), {
            code: "ERR_MODULE_NOT_FOUND",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  test("the official SDK's module satisfies the sdk(load) constraint", () => {
    const connect = (native: SuperserveNative) => native.sdk(() => import("@superserve/sdk"));
    const account = (api: SuperserveProvider["api"]) => api.sdk(() => import("@superserve/sdk"));
    expectTypeOf<Awaited<ReturnType<typeof connect>>>().toEqualTypeOf<
      import("@superserve/sdk").Sandbox
    >();
    expectTypeOf<Awaited<ReturnType<typeof account>>>().toEqualTypeOf<
      typeof import("@superserve/sdk").Sandbox
    >();
  });
});

describe("lifecycle and protocol faults", () => {
  test("a create the caller aborts mid-request still completes remotely and is deleted, not leaked", async () => {
    const provider = factory();
    const held = gate();
    state.createGate = held.promise;
    const before = state.boxes.size;
    const controller = new AbortController();
    const creating = provider.create({ labels: {}, signal: controller.signal });
    await vi.waitFor(() => expect(state.boxes.size).toBe(before + 1));
    controller.abort();
    held.open();
    state.createGate = undefined;
    await expect(creating).rejects.toMatchObject({ code: "aborted" });
    expect(state.boxes.size).toBe(before);
  });

  test("a session that drops mid-command is cancelled and reported, and the sandbox stays usable", async () => {
    const box = await createSandbox(factory());

    try {
      state.dropSessions = 1;
      await expect(box.run("cat; sleep 5", { stdin: "x" })).rejects.toMatchObject({
        code: "provider",
        message: expect.stringContaining("closed before the command finished"),
      });
      expect((await box.run("cat", { stdin: "after" })).stdout).toBe("after");
    } finally {
      state.dropSessions = 0;
      await box.destroy();
    }
  });

  test("a cut exec response is a provider error, never a parsed result", async () => {
    const provider = factory();
    const box = await provider.create({ labels: {} });

    try {
      await provider.files.list(box.id, "/workspace");
      state.cutExec = 1;
      await expect(provider.files.list(box.id, "/workspace")).rejects.toMatchObject({
        code: "provider",
        provider: "superserve",
      });
    } finally {
      state.cutExec = 0;
      await provider.destroy(box.id);
    }
  });
});

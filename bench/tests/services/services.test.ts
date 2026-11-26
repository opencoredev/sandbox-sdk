import { SandboxError, type RunOptions, type RunResult } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { describe, expect, test } from "vitest";
import {
  runServicesAttempt,
  Guest,
  StageFailure,
  getDaemon,
  metricsOf,
  stepTimeoutMs,
  type GuestBox,
} from "../../src/services/attempt.js";
import { SpendGuard, parseProviderCaps } from "../../src/services/budget.js";
import {
  isolation,
  nestedVirt,
  parseProbe,
  rootlessPrerequisites,
  type Probe,
} from "../../src/services/probe.js";
import {
  attemptRecordSchema,
  type AttemptRecord,
  type DaemonRecord,
  type Phase,
} from "../../src/services/record.js";
import { median, servicesSiteData, summaryMarkdown } from "../../src/services/summary.js";

const probeLines = {
  uid: "0",
  user: "root",
  arch: "x86_64",
  kernel: "6.1.0",
  os: "debian 12",
  libc: "glibc 2.36",
  sudo: "root",
  virt: "kvm",
  gvisor: "no",
  hypervisorFlag: "yes",
  dmiVendor: "none",
  dmiProduct: "none",
  containerMarker: "none",
  pid1: "init",
  kvmDevice: "none",
  vmxSvm: "no",
  capEff: "000001ffffffffff",
  capSysAdmin: "yes",
  capNetAdmin: "yes",
  seccomp: "0",
  noNewPrivs: "0",
  cgroupFs: "cgroup2fs",
  cgroupControllers: "cpu memory pids",
  cgroupWritable: "yes",
  overlayFs: "yes",
  fuseDevice: "no",
  iptables: "none",
  nft: "no",
  userns: "yes",
  maxUserNamespaces: "1000",
  newuidmap: "no",
  subuid: "no",
  dockerCli: "none",
  dockerInfo: "no",
  dockerd: "no",
  dockerSocket: "no",
  composePlugin: "none",
  podman: "none",
  podmanInfo: "no",
  containerd: "no",
  node: "none",
  setpriv: "yes",
  libstdcxx: "yes",
  aptGet: "yes",
  curl: "yes",
  tmpFreeMb: "9000",
  rootFreeMb: "9000",
  memTotalMb: "8000",
  nproc: "4",
  dockerHub: "401",
};

const probeOutput = (overrides: Record<string, string> = {}) =>
  Object.entries({ ...probeLines, ...overrides })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

function probeOf(overrides: Record<string, string> = {}): Probe {
  const parsed = parseProbe(probeOutput(overrides));

  if (parsed.kind !== "parsed") throw new Error(parsed.error);

  return parsed.probe;
}

describe("probe", () => {
  test("parses key=value output and ignores other lines", () => {
    const parsed = parseProbe(`noise\n${probeOutput()}\n`);
    expect(parsed.kind).toBe("parsed");
  });

  test("a garbled probe is reported, not invented", () => {
    const parsed = parseProbe(probeOutput({ sudo: "maybe" }));
    expect(parsed).toMatchObject({ kind: "invalid" });
    expect(parsed.kind === "invalid" && parsed.error).toContain("sudo");
  });

  test("summaries", () => {
    expect(isolation(probeOf())).toBe("VM (kvm)");
    expect(isolation(probeOf({ gvisor: "yes" }))).toBe("gVisor");
    expect(isolation(probeOf({ virt: "docker" }))).toBe("container (docker)");
    expect(nestedVirt(probeOf({ kvmDevice: "rw" }))).toBe("kvm-device-rw");
    expect(rootlessPrerequisites(probeOf())).toContain("root");
    expect(rootlessPrerequisites(probeOf({ uid: "1000", sudo: "no" }))).toContain("newuidmap");
  });
});

describe("spend guard", () => {
  test("refuses an attempt that would cross the run or provider cap, and settles", () => {
    const guard = new SpendGuard(1, parseProviderCaps("e2b=0.5"));
    const a = guard.reserve("e2b", 0.4);
    expect(a).not.toBeNull();
    expect(guard.reserve("e2b", 0.2)).toBeNull();
    expect(guard.reserve("daytona", 0.7)).toBeNull();

    if (a) guard.settle(a, 0.1);
    expect(guard.state()).toEqual({ spentUSD: 0.1, reservedUSD: 0 });
    expect(guard.reserve("e2b", 0.35)).not.toBeNull();
  });

  test("bad caps are refused", () => {
    expect(() => new SpendGuard(Number.NaN)).toThrow();
    expect(() => parseProviderCaps("e2b=x")).toThrow();
  });
});

const phase = (name: string, startedAt: number, endedAt: number, ok = true): Phase => ({
  name,
  startedAt,
  endedAt,
  ok,
  exitCode: ok ? 0 : 1,
  timedOut: false,
});

describe("metrics", () => {
  const compose = [
    phase("create", 0, 1000),
    phase("probe", 1000, 2000),
    phase("upload", 2000, 5000),
    phase("unpack", 5000, 6000),
    phase("daemon-fetch:static", 6000, 9000),
    phase("daemon-start:static-rootful:default", 9000, 12_000, false),
    phase("daemon-start:static-rootful:no-iptables", 12_000, 14_000),
    phase("compose-fetch", 14_000, 15_000),
    phase("image-pull", 15_000, 25_000),
    phase("services-start", 25_000, 27_000),
    phase("services-ready", 27_000, 30_000),
    phase("tests", 30_000, 31_000),
  ];

  test("compose: services up runs from the first daemon step to readiness", () => {
    const m = metricsOf("compose", compose, true);
    expect(m).toMatchObject({
      createMs: 1000,
      daemonReadyMs: 8000,
      imagePullMs: 10_000,
      servicesStartMs: 2000,
      servicesUpMs: 24_000,
      readyToGreenMs: 29_000,
      testsMs: 1000,
    });
  });

  test("a failed attempt keeps what it reached and nulls the rest", () => {
    const failed = compose
      .slice(0, 9)
      .map((p) => (p.name === "image-pull" ? { ...p, ok: false } : p));

    const m = metricsOf("compose", failed, false);
    expect(m.daemonReadyMs).toBe(8000);
    expect(m.imagePullMs).toBeNull();
    expect(m.servicesUpMs).toBeNull();
    expect(m.readyToGreenMs).toBeNull();
  });

  test("native: services up runs from the bundle upload", () => {
    const m = metricsOf(
      "native",
      [
        phase("upload", 0, 1000),
        phase("bundle-upload", 1000, 2000),
        phase("bundle-unpack", 2000, 2500),
        phase("postgres-init", 2500, 3000),
        phase("postgres-start", 3000, 3200),
        phase("redis-start", 3200, 3300),
        phase("services-ready", 3300, 3400),
        phase("tests", 3400, 4000),
      ],
      true,
    );

    expect(m).toMatchObject({
      servicesStartMs: 800,
      servicesUpMs: 2400,
      readyToGreenMs: 4000,
      daemonReadyMs: null,
    });
  });
});

/** A scripted guest: the first matching rule answers each command. */
function scriptedBox(rules: [RegExp, (command: string) => Partial<RunResult>][]) {
  const commands: string[] = [];
  const started: string[] = [];

  const box: GuestBox = {
    run(command: string, _options: RunOptions) {
      commands.push(command);
      const rule = rules.find(([pattern]) => pattern.test(command));
      const result = rule ? rule[1](command) : { ok: true, exitCode: 0 };
      const output = result.output ?? "";

      return Promise.resolve({
        ok: result.ok ?? true,
        exitCode: result.exitCode ?? 0,
        stdout: output,
        stderr: "",
        output,
        durationMs: 1,
        truncated: false,
        timedOut: false,
        cwd: "/",
        command,
      });
    },
    async start(command: string) {
      started.push(command);

      return { name: command };
    },
    files: { write: async () => {} },
  };

  return { box, commands, started };
}

function guestFor(box: GuestBox) {
  let t = 0;
  const g = new Guest(box, new AbortController().signal, [], () => (t += 1000));
  g.pollMs = 0;

  return g;
}

const pingOk = JSON.stringify({ ok: true, serverVersion: "29.9.3", storageDriver: "overlay2" });

describe("daemon ladder", () => {
  test("a running daemon is used as found", async () => {
    const { box, started } = scriptedBox([
      [/daemon-ping/, () => ({ output: pingOk })],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const g = guestFor(box);

    const d = await getDaemon(
      g,
      probeOf({ dockerInfo: "yes", dockerCli: "Docker 28" }),
      10_000,
      () => {},
    );

    expect(d.record).toMatchObject({
      method: "preinstalled-running",
      compose: "preinstalled",
      storageDriver: "overlay2",
    });
    expect(started).toEqual([]);
    expect(d.compose).toBe("docker compose");
  });

  test("root without Docker: fetch the static bundle, fall through a failing config, fetch compose", async () => {
    let starts = 0;

    const { box, commands, started } = scriptedBox([
      [
        /daemon-ping/,
        () =>
          starts >= 2 ? { output: pingOk } : { ok: false, exitCode: 1, output: '{"ok":false}' },
      ],
      [/pgrep -x dockerd/, () => ({ output: starts >= 2 ? "" : "DEAD" })],
      [/docker compose version/, () => ({ ok: false, exitCode: 1 })],
      [
        /tail -c 6000/,
        () => ({ output: 'level=error msg="failed to start daemon: iptables not found"' }),
      ],
    ]);

    box.start = async (command: string) => {
      starts++;
      started.push(command);

      return { name: command };
    };

    const g = guestFor(box);
    const d = await getDaemon(g, probeOf(), 10_000, () => {});
    expect(d.record.method).toBe("static-rootful");
    expect(d.record.config).toBe("no-iptables");
    expect(d.record.tries.map((t) => [t.method, t.config, t.ok])).toEqual([
      ["preinstalled-running", "as-found", false],
      ["static-rootful", "default", false],
      ["static-rootful", "no-iptables", true],
    ]);
    await d.collectLogs();
    expect(d.record.tries[1]?.error).toContain("iptables not found");
    expect(d.record.skipped.map((s) => s.method)).toEqual(["preinstalled-started"]);
    expect(d.record.compose).toBe("fetched");
    expect(commands.some((c) => c.includes("docker-29.9.3.tgz"))).toBe(true);
    expect(started[1]).toContain("--iptables=false");
    expect(g.phases.map((p) => p.name)).toContain("compose-fetch");
  });

  test("a daemon that answers but cannot mount overlay layers moves to the next vfs config", async () => {
    const { box, started } = scriptedBox([
      [
        /daemon-ping/,
        () => (started.length ? { output: pingOk } : { ok: false, exitCode: 1, output: "" }),
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const g = guestFor(box);
    const d = await getDaemon(g, probeOf(), 10_000, () => {});
    expect(d.record.config).toBe("default");
    expect(await d.switchStorage("failed to extract layer: invalid argument")).toBe(true);
    expect(d.record.config).toBe("vfs");
    expect(d.record.tries.map((t) => [t.config, t.ok])).toEqual([
      ["as-found", false],
      ["default", false],
      ["vfs", true],
    ]);
    expect(d.record.tries[1]?.error).toContain("answered, but failed to extract layer");
    expect(g.phases.find((p) => p.name === "daemon-start:static-rootful:default")?.ok).toBe(false);
    expect(started.at(-1)).toContain("--storage-driver=vfs");
  });

  test("no root, no sudo, nothing installed: the socket is checked, every other method skipped with its reason", async () => {
    const { box } = scriptedBox([[/daemon-ping/, () => ({ ok: false, exitCode: 1, output: "" })]]);
    const captured: DaemonRecord[] = [];

    const failure = await getDaemon(
      guestFor(box),
      probeOf({ uid: "1000", sudo: "no", userns: "no" }),
      10_000,
      (found) => {
        captured.push(found.record);
      },
    ).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(StageFailure);
    expect(failure instanceof StageFailure && failure.reason).toBe("no daemon method worked");
    expect(captured[0]).toMatchObject({
      method: null,
      tries: [{ method: "preinstalled-running", ok: false }],
      skipped: [
        { method: "preinstalled-started" },
        { method: "static-rootful", reason: "not root and no passwordless sudo" },
        { method: "rootless", reason: expect.stringContaining("user namespaces") },
        { method: "podman", reason: "the image has no podman" },
      ],
    });
  });

  test("a failed Docker download is a failed rung, and the ladder reaches podman", async () => {
    const { box } = scriptedBox([
      [
        /daemon-ping/,
        (c) => (c.includes("podman.sock") ? { output: pingOk } : { ok: false, exitCode: 1 }),
      ],
      [
        /fetch\.mjs .*docker-29/,
        () => ({ ok: false, exitCode: 1, output: '{"ok":false,"error":"HTTP 403"}' }),
      ],
      [/docker-compose version/, () => ({ output: "5.6.1" })],
    ]);

    const d = await getDaemon(
      guestFor(box),
      probeOf({ podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    expect(d.record.method).toBe("podman");
    expect(d.record.tries.find((t) => t.config === "fetch")).toMatchObject({
      method: "static-rootful",
      ok: false,
      error: expect.stringContaining("HTTP 403"),
    });
  });

  test("an exec error during the download is also a failed rung", async () => {
    const { box } = scriptedBox([
      [
        /daemon-ping/,
        (c) => (c.includes("podman.sock") ? { output: pingOk } : { ok: false, exitCode: 1 }),
      ],
      [/docker-compose version/, () => ({ output: "5.6.1" })],
    ]);

    const run = box.run;
    box.run = (command: string, options: RunOptions) =>
      command.includes("fetch.mjs") && command.includes("docker-29")
        ? Promise.reject(new Error("transport closed"))
        : run(command, options);

    const d = await getDaemon(
      guestFor(box),
      probeOf({ podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    expect(d.record.method).toBe("podman");
    expect(d.record.tries.find((t) => t.config === "fetch")?.error).toContain("transport closed");
  });
});

function record(input: {
  provider: string;
  path: "compose" | "native";
  attempt: number;
  up: number | null;
  method?: "preinstalled-running" | "static-rootful";
}): AttemptRecord {
  const green = input.up !== null;

  return {
    schema: "svc-attempt/1",
    runId: "r1",
    attemptId: `${input.provider}-${input.path}-${input.attempt}`,
    provider: input.provider,
    track: "same-machine",
    path: input.path,
    attempt: input.attempt,
    sandboxIds: ["sb"],
    startedAt: 0,
    endedAt: 1,
    probe: probeOf(),
    probeError: null,
    daemon:
      input.path === "compose"
        ? {
            method: green ? (input.method ?? "static-rootful") : null,
            config: green ? "default" : null,
            skipped: [],
            tries: [
              {
                method: "static-rootful",
                config: "default",
                ok: green,
                ms: 1,
                error: green ? null : "daemon exited",
              },
            ],
            storageDriver: null,
            network: green ? "bridge" : null,
            serverVersion: null,
            compose: green ? "fetched" : null,
            finished: true,
          }
        : null,
    phases: [],
    outcome: green
      ? { kind: "green", testsPassed: 9 }
      : { kind: "failed", stage: "daemon", reason: "no daemon method worked", detail: "" },
    metrics: {
      createMs: 1000,
      probeMs: 100,
      uploadMs: 2000,
      daemonReadyMs: null,
      imagePullMs: null,
      servicesStartMs: null,
      servicesReadyMs: null,
      servicesUpMs: input.up,
      testsMs: green ? 500 : null,
      readyToGreenMs: input.up === null ? null : input.up + 3000,
    },
    deletionConfirmed: true,
    estimatedUSD: 0.01,
    artifacts: { node: "n", fixture: "f", native: input.path === "native" ? "b" : null },
    outputDir: null,
  };
}

describe("site data", () => {
  const records = [
    record({ provider: "a", path: "compose", attempt: 1, up: 30_000 }),
    record({ provider: "a", path: "compose", attempt: 2, up: 20_000 }),
    record({ provider: "a", path: "compose", attempt: 3, up: null }),
    record({ provider: "a", path: "native", attempt: 1, up: 4000 }),
    record({ provider: "b", path: "compose", attempt: 1, up: null }),
    record({ provider: "b", path: "native", attempt: 1, up: 2000 }),
  ];

  const site = servicesSiteData({
    records,
    runs: [
      {
        id: "r1",
        sdkCommit: "abcdef0",
        startedAt: "x",
        endedAt: "y",
        location: "test",
        settings: {},
        artifacts: { node: "n", fixture: "f", native: "b" },
      },
    ],
    generatedAt: "now",
  });

  test("each path has its own ranking, over green attempts only", () => {
    expect(site.rankings.compose[0]?.entries).toEqual([
      { provider: "a", settings: "", medianServicesUpS: 25, green: 2, attempts: 3 },
    ]);
    expect(site.rankings.native[0]?.entries.map((r) => r.provider)).toEqual(["b", "a"]);
  });

  test("tracks and run settings never pool: separate rows, separate rankings", () => {
    const run = (id: string, settings: Record<string, string>) => ({
      id,
      sdkCommit: "abcdef0",
      startedAt: "x",
      endedAt: "y",
      location: "test",
      settings,
      artifacts: { node: "n", fixture: "f", native: "b" },
    });

    const vm = {
      ...record({ provider: "modal", path: "native", attempt: 1, up: 1000 }),
      runId: "r-vm",
    };

    const gvisor = {
      ...record({ provider: "modal", path: "native", attempt: 1, up: 9000 }),
      runId: "r-g",
    };

    const other = {
      ...record({ provider: "e2b", path: "native", attempt: 1, up: 3000 }),
      runId: "r-g",
      track: "default",
    };

    const data = servicesSiteData({
      records: [vm, gvisor, other],
      runs: [run("r-vm", { modal: "runtime=vm", e2b: "ignored" }), run("r-g", {})],
    });

    expect(data.providers.map((p) => [p.provider, p.track, p.settings])).toEqual([
      ["e2b", "default", ""],
      ["modal", "same-machine", ""],
      ["modal", "same-machine", "runtime=vm"],
    ]);
    expect(data.rankings.native.map((r) => [r.track, r.entries.length])).toEqual([
      ["default", 1],
      ["same-machine", 2],
    ]);
  });

  test("a duplicated attempt or an unknown run is refused", () => {
    const runs = [
      {
        id: "r1",
        sdkCommit: "a",
        startedAt: "x",
        endedAt: null,
        location: "t",
        settings: {},
        artifacts: { node: "n", fixture: "f", native: "b" },
      },
    ];

    const one = record({ provider: "a", path: "native", attempt: 1, up: 1 });
    expect(() => servicesSiteData({ records: [one, one], runs })).toThrow("appears twice");
    expect(() => servicesSiteData({ records: [{ ...one, runId: "zz" }], runs })).toThrow(
      "not given",
    );
  });

  test("a green record with fewer than every test is refused at the boundary", () => {
    const one = record({ provider: "a", path: "native", attempt: 1, up: 1 });
    expect(attemptRecordSchema.safeParse(one).success).toBe(true);
    expect(
      attemptRecordSchema.safeParse({ ...one, outcome: { kind: "green", testsPassed: 8 } }).success,
    ).toBe(false);
  });

  test("failures stay in the data with their stage", () => {
    const a = site.providers.find((p) => p.provider === "a");
    expect(a?.compose.failures).toEqual([
      { attempt: 3, attemptId: "a-compose-3", stage: "daemon", reason: "no daemon method worked" },
    ]);
    expect(a?.capability.docker).toBe("flaky");
    expect(site.providers.find((p) => p.provider === "b")?.capability.docker).toBe("fails");
  });

  test("a provider with no Docker is unsupported with its reason, not a failed row", () => {
    const b = site.providers.find((p) => p.provider === "b");
    expect(b?.compose.status).toBe("unsupported");
    expect(b?.compose.unsupportedReason).toBe(
      "No Docker daemon started. tried and failed: static-rootful/default: daemon exited",
    );
    expect(b?.native.status).toBe("measured");
    expect(b?.native.unsupportedReason).toBeNull();

    const a = site.providers.find((p) => p.provider === "a");
    expect(a?.compose.status).toBe("measured");

    const markdown = summaryMarkdown(site);
    expect(markdown).toContain("| unsupported (0/1) |");
    expect(markdown).toContain("- b compose: No Docker daemon started.");
    expect(markdown).not.toContain("- b compose #1: daemon");
    expect(markdown).toContain("- a compose #3: daemon: no daemon method worked");
  });

  test("unsupported attempts and skipped providers are results, not failures", () => {
    const unsupported = (path: "compose" | "native"): AttemptRecord => ({
      ...record({ provider: "arm", path, attempt: 1, up: null }),
      daemon: null,
      outcome: {
        kind: "unsupported",
        reason: "no pinned artifacts for aarch64",
        detail: "x86_64 only",
      },
    });

    const data = servicesSiteData({
      records: [unsupported("compose"), unsupported("native")],
      runs: [
        {
          id: "r1",
          sdkCommit: "abcdef0",
          startedAt: "x",
          endedAt: "y",
          location: "test",
          settings: {},
          artifacts: { node: "n", fixture: "f", native: "b" },
        },
      ],
      notRun: [{ runId: "r1", provider: "vercel", reason: "missing VERCEL_OIDC_TOKEN" }],
    });

    const arm = data.providers[0];
    expect(arm?.compose.status).toBe("unsupported");
    expect(arm?.native.status).toBe("unsupported");
    expect(arm?.native.unsupportedReason).toBe("no pinned artifacts for aarch64: x86_64 only");
    expect(arm?.native.failures).toEqual([]);
    expect(data.rankings.native[0]?.entries).toEqual([]);
    expect(data.notRun).toEqual([
      { runId: "r1", provider: "vercel", reason: "missing VERCEL_OIDC_TOKEN" },
    ]);
    expect(summaryMarkdown(data)).toContain("- vercel (r1): missing VERCEL_OIDC_TOKEN");
  });

  test("docs claims are labelled as docs and the table renders", () => {
    expect(site.providers[0]?.capability.nativeServices).toBeNull();
    expect(summaryMarkdown(site)).toContain("| a |");
  });

  test("median", () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([4, 1])).toBe(2.5);
    expect(median([null])).toBeNull();
  });
});

describe("attempt cleanup", () => {
  const artifacts = {
    schema: "svc-artifacts/1" as const,
    createdAt: "x",
    node: { sha256: "a".repeat(64), bytes: 1, version: "22" },
    fixture: { sha256: "b".repeat(64), bytes: 1, sourceSha256: "s" },
    native: {
      sha256: "c".repeat(64),
      bytes: 1,
      postgresInputSha256: "p",
      redisSourceSha256: "r",
      redisBuild: "b",
    },
  };

  test("a create that fails but names its sandbox journals it, deletes it and keeps the cost", async () => {
    const backing = memory();
    const destroyed: string[] = [];
    const journaled: string[] = [];

    const provider = {
      ...backing,
      create: async () => {
        throw new SandboxError("Sandbox did not become usable", {
          provider: "memory",
          code: "outcome_unknown",
          sandboxId: "stray-1",
        });
      },
      destroy: async (id: string) => {
        destroyed.push(id);
      },
    };

    const record = await runServicesAttempt(
      {
        runId: "r",
        ownerLabel: "r-1234",
        attemptId: "m-native-1",
        attempt: 1,
        path: "native",
        track: "same-machine",
        entry: { name: "memory", provider, attribution: "none", settlementMs: null, paddingMs: 0 },
        artifacts,
        timeoutMs: 60_000,
      },
      {
        read: async () => new Uint8Array(),
        onSandbox: async (_, id) => {
          journaled.push(id);
        },
        estimate: () => 0.5,
      },
    );

    expect(record.outcome).toMatchObject({
      kind: "failed",
      stage: "create",
      reason: "create failed (outcome_unknown)",
    });
    expect(journaled).toEqual(["stray-1"]);
    expect(destroyed).toEqual(["stray-1"]);
    expect(record.sandboxIds).toEqual(["stray-1"]);
    expect(record.deletionConfirmed).toBe(true);
    expect(record.estimatedUSD).toBe(0.5);
  });

  test("a create that is still running at the deadline stays unresolved, not a clean refusal", async () => {
    const backing = memory();

    const provider = {
      ...backing,
      create: (input: Parameters<typeof backing.create>[0]) =>
        new Promise<Awaited<ReturnType<typeof backing.create>>>((resolve, reject) => {
          setTimeout(() => {
            backing.create(input).then(resolve, reject);
          }, 300);
        }),
    };

    const record = await runServicesAttempt(
      {
        runId: "r",
        ownerLabel: "r-1234",
        attemptId: "m-native-1",
        attempt: 1,
        path: "native",
        track: "same-machine",
        entry: { name: "memory", provider, attribution: "none", settlementMs: null, paddingMs: 0 },
        artifacts,
        timeoutMs: 20,
        deadlineGraceMs: 10,
      },
      {
        read: async () => new Uint8Array(),
        onSandbox: async () => {},
        estimate: () => 0.5,
        destroyTimeoutMs: 50,
      },
    );

    expect(record.outcome).toMatchObject({ kind: "failed" });
    expect(record.deletionConfirmed).toBe(false);
    expect(record.estimatedUSD).toBe(0.5);
  });

  const latePlan = (provider: Parameters<typeof runServicesAttempt>[0]["entry"]["provider"]) => ({
    runId: "r",
    ownerLabel: "r-1234",
    attemptId: "m-native-1",
    attempt: 1,
    path: "native" as const,
    track: "same-machine",
    entry: {
      name: "memory",
      provider,
      attribution: "none" as const,
      settlementMs: null,
      paddingMs: 0,
    },
    artifacts,
    timeoutMs: 20,
    deadlineGraceMs: 10,
  });

  test("a create that lands after the deadline but inside the cleanup window is journaled and deleted", async () => {
    const backing = memory();
    const destroyed: string[] = [];
    const journaled: string[] = [];

    const provider = {
      ...backing,
      create: (input: Parameters<typeof backing.create>[0]) =>
        new Promise<Awaited<ReturnType<typeof backing.create>>>((resolve, reject) => {
          setTimeout(() => {
            backing.create(input).then(resolve, reject);
          }, 80);
        }),
      destroy: async (id: string) => {
        destroyed.push(id);
        await backing.destroy(id);
      },
    };

    const record = await runServicesAttempt(latePlan(provider), {
      read: async () => new Uint8Array(),
      onSandbox: async (_, id) => {
        journaled.push(id);
      },
      estimate: () => 0.5,
      destroyTimeoutMs: 2000,
    });

    expect(record.sandboxIds).toHaveLength(1);
    expect(journaled).toEqual(record.sandboxIds);
    expect(destroyed).toEqual(record.sandboxIds);
    expect(record.deletionConfirmed).toBe(true);
    expect(await backing.list({})).toEqual([]);
  });

  test("a late create error that names its sandbox is deleted too", async () => {
    const backing = memory();
    const destroyed: string[] = [];

    const provider = {
      ...backing,
      create: () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new SandboxError("Not usable", {
                provider: "memory",
                code: "outcome_unknown",
                sandboxId: "late-1",
              }),
            );
          }, 80);
        }),
      destroy: async (id: string) => {
        destroyed.push(id);
      },
    };

    const record = await runServicesAttempt(latePlan(provider), {
      read: async () => new Uint8Array(),
      onSandbox: async () => {},
      estimate: () => 0.5,
      destroyTimeoutMs: 2000,
    });

    expect(destroyed).toEqual(["late-1"]);
    expect(record.sandboxIds).toEqual(["late-1"]);
    expect(record.deletionConfirmed).toBe(true);
  });

  test("a definitive create refusal leaves nothing unresolved", async () => {
    const backing = memory();

    const provider = {
      ...backing,
      create: async () => {
        throw new SandboxError("Bad size", { provider: "memory", code: "invalid_argument" });
      },
    };

    const record = await runServicesAttempt(
      { ...latePlan(provider), timeoutMs: 60_000 },
      { read: async () => new Uint8Array(), onSandbox: async () => {}, estimate: () => 0.5 },
    );

    expect(record.outcome).toMatchObject({
      stage: "create",
      reason: "create failed (invalid_argument)",
    });
    expect(record.deletionConfirmed).toBe(true);
    expect(record.estimatedUSD).toBe(0);
  });

  test("an unknown create outcome without an ID stays unconfirmed for the label sweep", async () => {
    const backing = memory();

    const provider = {
      ...backing,
      create: async () => {
        throw new SandboxError("Lost response", { provider: "memory", code: "outcome_unknown" });
      },
    };

    const record = await runServicesAttempt(
      {
        runId: "r",
        ownerLabel: "r-1234",
        attemptId: "m-native-1",
        attempt: 1,
        path: "native",
        track: "same-machine",
        entry: { name: "memory", provider, attribution: "none", settlementMs: null, paddingMs: 0 },
        artifacts,
        timeoutMs: 60_000,
      },
      { read: async () => new Uint8Array(), onSandbox: async () => {}, estimate: () => 0.5 },
    );

    expect(record.deletionConfirmed).toBe(false);
    expect(record.sandboxIds).toEqual([]);
    expect(record.estimatedUSD).toBe(0.5);
  });

  test("a guest the pinned artifacts cannot run on ends unsupported after the probe, on both paths", async () => {
    const commands: string[] = [];

    const provider = memory({
      handlers: {
        mkdir: () => 0,
        unset: () => 0,
        sh: ({ args, stdout }) => {
          commands.push(`sh ${args.join(" ")}`);
          stdout(probeOutput({ arch: "aarch64" }));

          return 0;
        },
      },
    });

    for (const path of ["compose", "native"] as const) {
      const record = await runServicesAttempt(
        {
          runId: "r",
          ownerLabel: "r-1234",
          attemptId: `m-${path}-1`,
          attempt: 1,
          path,
          track: "same-machine",
          entry: {
            name: "memory",
            provider,
            attribution: "none",
            settlementMs: null,
            paddingMs: 0,
          },
          artifacts,
          timeoutMs: 60_000,
        },
        {
          read: async () => {
            throw new Error("nothing is uploaded to an unsupported guest");
          },
          onSandbox: async () => {},
          estimate: () => 0.01,
        },
      );

      expect(record.outcome).toMatchObject({
        kind: "unsupported",
        reason: "no pinned artifacts for aarch64",
      });
      expect(record.probe?.arch).toBe("aarch64");
      expect(record.phases.map((p) => p.name)).toEqual(["create", "probe", "destroy"]);
      expect(record.deletionConfirmed).toBe(true);
    }

    expect(commands).toHaveLength(2);
  });
});

describe("step timeouts", () => {
  test("every guest step keeps at least 3x its pilot measurement and its floor", () => {
    // svc-pilot1 and svc-pilot2 (2026-11-26, e2b): the slowest measurement of each step, in ms.
    const measured: Record<keyof typeof stepTimeoutMs, number> = {
      probe: 3213,
      unpack: 2200,
      bundleUnpack: 700,
      portsFree: 200,
      postgresInit: 700,
      postgresStart: 200,
      redisStart: 300,
      daemonFetch: 5800,
      composeFetch: 2000,
      imagePull: 15460,
      servicesStart: 3288,
      servicesReady: 993,
      tests: 916,
    };

    const slowest = new Map<string, number>(Object.entries(measured));

    for (const [step, timeout] of Object.entries(stepTimeoutMs)) {
      const ms = slowest.get(step);
      expect(ms, step).toBeDefined();
      expect(timeout, step).toBeGreaterThanOrEqual(Math.max(3 * (ms ?? 0), 60_000));
    }
  });
});

describe("ladder provider failures", () => {
  test("a sandbox that vanishes while a daemon starts is a provider error, not a Docker result", async () => {
    const { box } = scriptedBox([[/daemon-ping/, () => ({ ok: false, exitCode: 1 })]]);
    box.start = async () => {
      throw new SandboxError("E2B GET /sandboxes/{id} failed (HTTP 404)", {
        provider: "e2b",
        code: "not_found",
      });
    };

    const failure = await getDaemon(guestFor(box), probeOf(), 10_000, () => {}).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(StageFailure);
    expect(failure instanceof StageFailure && [failure.stage, failure.reason]).toEqual([
      "error",
      "sandbox disappeared",
    ]);
  });
});

describe("ladder aborts", () => {
  test("an abort during the ladder is a timeout, not a Docker verdict, and starts nothing more", async () => {
    const controller = new AbortController();
    const { box, started } = scriptedBox([[/daemon-ping/, () => ({ ok: false, exitCode: 1 })]]);
    box.start = async (command: string) => {
      started.push(command);
      controller.abort(new Error("deadline"));

      return { name: command };
    };

    let t = 0;
    const g = new Guest(box, controller.signal, [], () => (t += 1000));
    g.pollMs = 0;

    const failure = await getDaemon(g, probeOf(), 10_000, () => {}).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure instanceof StageFailure && failure.stage).toBe("timeout");
    expect(started).toHaveLength(1);
  });
});

describe("summary inputs", () => {
  test("a row from before `finished` existed stays out of the Docker verdict", () => {
    const run = {
      id: "r1",
      sdkCommit: "a",
      startedAt: "x",
      endedAt: null,
      location: "t",
      settings: {},
      artifacts: { node: "n", fixture: "f", native: "b" },
    };

    const legacy = record({ provider: "a", path: "compose", attempt: 1, up: 1000 });
    const daemon = legacy.daemon ? { ...legacy.daemon, finished: false } : null;
    const data = servicesSiteData({ records: [{ ...legacy, daemon }], runs: [run] });
    expect(data.providers[0]?.capability.docker).toBe("not-reached");
  });

  test("a native row must carry its run's bundle hash", () => {
    const run = {
      id: "r1",
      sdkCommit: "a",
      startedAt: "x",
      endedAt: null,
      location: "t",
      settings: {},
      artifacts: { node: "n", fixture: "f", native: "b" },
    };

    const one = record({ provider: "a", path: "native", attempt: 1, up: 1 });
    expect(() =>
      servicesSiteData({
        records: [{ ...one, artifacts: { ...one.artifacts, native: null } }],
        runs: [run],
      }),
    ).toThrow("ran other artifacts");
  });

  test("an attempt is refused when its artifacts differ from its run's", () => {
    const run = {
      id: "r1",
      sdkCommit: "a",
      startedAt: "x",
      endedAt: null,
      location: "t",
      settings: {},
      artifacts: { node: "n", fixture: "f", native: "b" },
    };

    const one = record({ provider: "a", path: "native", attempt: 1, up: 1 });
    expect(() =>
      servicesSiteData({
        records: [{ ...one, artifacts: { ...one.artifacts, fixture: "old" } }],
        runs: [run],
      }),
    ).toThrow("ran other artifacts");
  });

  test("runs from different commits or artifacts are never pooled", () => {
    const base = {
      sdkCommit: "aaaaaaa",
      startedAt: "x",
      endedAt: null,
      location: "t",
      settings: {},
      artifacts: { node: "n", fixture: "f", native: "b" },
    };

    expect(() =>
      servicesSiteData({
        records: [],
        runs: [
          { ...base, id: "r1" },
          { ...base, id: "r2", sdkCommit: "bbbbbbb" },
        ],
      }),
    ).toThrow("summarize them separately");
  });
});

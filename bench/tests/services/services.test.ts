import { SandboxError, type RunOptions, type RunResult } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  runServicesAttempt,
  Guest,
  StageFailure,
  getDaemon,
  composeProject,
  metricsOf,
  stepTimeoutMs,
  refusedPrerequisite,
  stopTree,
  cleanupStatus,
  projectCleanupOf,
  systemBin,
  type GuestBox,
} from "../../src/services/attempt.js";
import { stalePins, type Artifacts } from "../../src/services/artifacts.js";
import { servicesCommand, servicesFactory } from "../../src/services/cli.js";
import { node, redisSource, zonkyPostgres } from "../../src/services/pins.js";
import { SpendGuard, parseProviderCaps } from "../../src/services/budget.js";
import {
  isolation,
  nestedVirt,
  parseProbe,
  probeScript,
  rootlessPrerequisites,
  type Probe,
} from "../../src/services/probe.js";
import {
  attemptRecordSchema,
  type AttemptRecord,
  type DaemonRecord,
  type DaemonTry,
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

  test("an empty or unknown architecture is no probe, so it cannot decide a verdict", () => {
    expect(parseProbe(probeOutput({ arch: "" }))).toMatchObject({ kind: "invalid" });
    expect(parseProbe(probeOutput({ arch: "uname: not found" }))).toMatchObject({
      kind: "invalid",
    });
    expect(probeOf({ arch: "aarch64" }).arch).toBe("aarch64");
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

      // Unscripted, the ownership scan sees no other daemon and every stop is confirmed.
      const result = rule
        ? rule[1](command)
        : command.includes('"SCANNED $n"')
          ? { output: "SCANNED 12" }
          : command.includes("kill -TERM")
            ? { output: "STOPPED" }
            : { ok: true, exitCode: 0 };

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
  g.mono = () => (t += 1000);

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
  cleanup?: "confirmed" | "unconfirmed";
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
                conclusive: !green,
              },
            ],
            storageDriver: null,
            network: green ? "bridge" : null,
            serverVersion: null,
            compose: green ? "fetched" : null,
            project: null,
            launched: green && input.method !== "preinstalled-running",
            down: null,
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
    cleanup: input.cleanup ?? "confirmed",
    projectCleanup: input.path === "compose" && green ? "down" : "none",
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
    // a-compose-3's only try is conclusive, so it is an unsupported attempt, not a failure.
    expect(a?.compose.failures).toEqual([]);
    expect(a?.compose.unsupported).toEqual([
      {
        runId: "r1",
        attempt: 3,
        attemptId: "a-compose-3",
        reason:
          "No Docker daemon started. tried and refused: static-rootful/default: daemon exited",
      },
    ]);

    const base = record({ provider: "a", path: "compose", attempt: 3, up: null });

    const inconclusive: AttemptRecord = {
      ...base,
      daemon: base.daemon
        ? { ...base.daemon, tries: base.daemon.tries.map((t) => ({ ...t, conclusive: false })) }
        : null,
    };

    const failed = servicesSiteData({ records: [inconclusive], runs: site.runs }).providers[0];
    expect(failed?.compose.failures).toEqual([
      {
        runId: "r1",
        attempt: 3,
        attemptId: "a-compose-3",
        stage: "daemon",
        reason: "no daemon method worked",
      },
    ]);
    expect(failed?.compose.unsupported).toEqual([]);
    expect(a?.capability.docker).toBe("flaky");
    expect(site.providers.find((p) => p.provider === "b")?.capability.docker).toBe("fails");
  });

  test("a provider with no Docker is unsupported with its reason, not a failed row", () => {
    const b = site.providers.find((p) => p.provider === "b");
    expect(b?.compose.status).toBe("unsupported");
    expect(b?.compose.unsupportedReason).toBe(
      "No Docker daemon started. tried and refused: static-rootful/default: daemon exited",
    );
    expect(b?.native.status).toBe("measured");
    expect(b?.native.unsupportedReason).toBeNull();

    const a = site.providers.find((p) => p.provider === "a");
    expect(a?.compose.status).toBe("measured");

    const markdown = summaryMarkdown(site);
    expect(markdown).toContain("| unsupported (0/1) |");
    expect(markdown).toContain("- b compose: No Docker daemon started.");
    expect(markdown).not.toContain("- b compose #1: daemon");
    // In a measured row, the unsupported attempt keeps its own reason.
    expect(markdown).toContain("- a compose #3: No Docker daemon started.");
    expect(markdown).not.toContain("- a compose #3: daemon: no daemon method worked");
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

  test("an attempt that times out while its submission is journaled sends no create", async () => {
    const backing = memory();
    let creates = 0;

    const provider = {
      ...backing,
      create: async (input: Parameters<typeof backing.create>[0]) => {
        creates++;

        return backing.create(input);
      },
    };

    const notSent: string[] = [];

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
        timeoutMs: 10,
        deadlineGraceMs: 5000,
      },
      {
        read: async () => new Uint8Array(),
        onSandbox: async () => {},
        onSubmit: () => new Promise((resolve) => setTimeout(resolve, 50)),
        onNotSent: async (_, id) => {
          notSent.push(id);
        },
        estimate: () => 0.5,
      },
    );

    expect(creates).toBe(0);
    expect(notSent).toEqual(["m-native-1"]);
    expect(record.outcome).toMatchObject({
      kind: "failed",
      stage: "timeout",
      detail: "No create was sent",
    });
    expect(record.deletionConfirmed).toBe(true);
    expect(record.estimatedUSD).toBe(0);
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

describe("conclusive Docker evidence", () => {
  const run = {
    id: "r1",
    sdkCommit: "a",
    startedAt: "x",
    endedAt: null,
    location: "t",
    settings: {},
    artifacts: { node: "n", fixture: "f", native: "b" },
  };

  const refused: DaemonTry = {
    method: "static-rootful",
    config: "default",
    ok: false,
    ms: 1,
    error: "daemon exited: operation not permitted",
    conclusive: true,
  };

  const download: DaemonTry = {
    method: "static-rootful",
    config: "fetch",
    ok: false,
    ms: 1,
    error: "download failed: HTTP 503",
    conclusive: false,
  };

  const ladderFailure = (attempt: number, tries: DaemonTry[]): AttemptRecord => {
    const base = record({ provider: "p", path: "compose", attempt, up: null });

    return { ...base, daemon: base.daemon ? { ...base.daemon, tries } : null };
  };

  const compose = (records: AttemptRecord[]) =>
    servicesSiteData({ records, runs: [run] }).providers[0]?.compose;

  test("a ladder that failed only on a download is failed, not unsupported", () => {
    expect(compose([ladderFailure(1, [download])])).toMatchObject({
      status: "failed",
      unsupportedReason: null,
    });
  });

  test("one inconclusive try or attempt keeps the row failed; all conclusive is unsupported", () => {
    expect(
      compose([ladderFailure(1, [refused]), ladderFailure(2, [refused, download])])?.status,
    ).toBe("failed");

    const both = compose([ladderFailure(1, [refused]), ladderFailure(2, [refused])]);
    expect(both?.status).toBe("unsupported");
    expect(both?.unsupportedReason).toContain(
      "static-rootful/default: daemon exited: operation not permitted",
    );
  });

  test("an attempt that failed before the ladder is not evidence either way", () => {
    const upload: AttemptRecord = {
      ...record({ provider: "p", path: "compose", attempt: 2, up: null }),
      daemon: null,
      outcome: { kind: "failed", stage: "upload", reason: "joining failed", detail: "" },
    };

    expect(compose([ladderFailure(1, [refused]), upload])?.status).toBe("failed");
  });
});

describe("daemon evidence and fallbacks", () => {
  const pingFail = { ok: false, exitCode: 1, output: '{"ok":false}' };

  test("no daemon on the socket and a log that refuses a named prerequisite are conclusive; a failed download is not", async () => {
    const { box } = scriptedBox([
      [
        /daemon-ping/,
        (c) =>
          c.includes("podman.sock")
            ? { output: pingOk }
            : {
                ok: false,
                exitCode: 1,
                output: '{"ok":false,"error":"connect ENOENT /var/run/docker.sock"}',
              },
      ],
      [/pgrep -x dockerd/, () => ({ output: "DEAD" })],
      [
        /fetch\.mjs .*docker-29/,
        () => ({ ok: false, exitCode: 1, output: '{"ok":false,"error":"HTTP 503"}' }),
      ],
      [
        /tail -c 6000/,
        () => ({
          output:
            "level=fatal msg=\"failed to start daemon: Error initializing network controller: iptables v1.8.9 (legacy): can't initialize iptables table `nat': Permission denied (you must be root)\"",
        }),
      ],
      [/docker-compose version/, () => ({ output: "5.6.1" })],
    ]);

    const d = await getDaemon(
      guestFor(box),
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    expect(d.record.method).toBe("podman");
    await d.collectLogs();

    const conclusive = (method: string, config: string) =>
      d.record.tries.find((t) => t.method === method && t.config === config)?.conclusive;

    expect(conclusive("preinstalled-running", "as-found")).toBe(true);
    expect(conclusive("preinstalled-started", "default")).toBe(true);
    expect(
      d.record.tries.find((t) => t.method === "preinstalled-started" && t.config === "default")
        ?.error,
    ).toContain("refused: iptables");
    expect(conclusive("static-rootful", "fetch")).toBe(false);
  });

  test("a log that only mentions a subsystem, or a full disk, is inconclusive", async () => {
    expect(
      refusedPrerequisite(
        "failed to start daemon: open /var/lib/docker/overlay2/state: no space left on device",
      ),
    ).toBeNull();
    expect(refusedPrerequisite('level=error msg="cgroup controller list"')).toBeNull();
    expect(refusedPrerequisite("operation not permitted")).toBeNull();
    expect(
      refusedPrerequisite(
        "error creating overlay mount to /var/lib/docker/overlay2/x/merged: invalid argument",
      ),
    ).toBe("an overlay mount");
    expect(refusedPrerequisite("dockerd needs to be started with root privileges")).toBe(
      "root privileges",
    );

    // Sol's reproduction: every launch logs ENOSPC on an overlay path. The ladder must not publish
    // that as unsupported.
    const { box } = scriptedBox([
      [/daemon-ping/, () => pingFail],
      [
        /tail -c 6000/,
        () => ({
          output:
            'level=fatal msg="failed to start daemon: open /var/lib/docker/overlay2/state: no space left on device"',
        }),
      ],
    ]);

    const kept: DaemonRecord[] = [];

    const failure = await getDaemon(guestFor(box), probeOf({ dockerd: "yes" }), 10_000, (d) => {
      kept.push(d.record);
    }).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure instanceof StageFailure && failure.reason).toBe("no daemon method worked");
    const tries = kept[0]?.tries ?? [];
    expect(tries.some((t) => t.error?.includes("no space left on device"))).toBe(true);
    expect(tries.every((t) => !t.conclusive)).toBe(true);
  });

  test("after the same method's vfs configs fail, the ladder goes on to the next methods", async () => {
    let starts = 0;

    const { box, started } = scriptedBox([
      [
        /daemon-ping/,
        (c) => (c.includes("podman.sock") || starts === 1 ? { output: pingOk } : pingFail),
      ],
      [/pgrep -x dockerd/, () => ({ output: "DEAD" })],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    box.start = async (command: string) => {
      starts++;
      started.push(command);

      return { name: command };
    };

    const g = guestFor(box);

    const d = await getDaemon(
      g,
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    expect(d.record.method).toBe("preinstalled-started");
    expect(
      await d.switchStorage(
        "failed to register layer: error creating overlay mount to /var/lib/docker/overlay2/l/merged: invalid argument",
      ),
    ).toBe(true);
    expect(d.record.method).toBe("podman");
    expect(d.record.finished).toBe(true);
    expect(new Set(d.record.tries.map((t) => t.method))).toEqual(
      new Set(["preinstalled-running", "preinstalled-started", "static-rootful", "podman"]),
    );
    expect(
      d.record.tries.find((t) => t.method === "preinstalled-started" && t.config === "default"),
    ).toMatchObject({ ok: false, conclusive: true });
    // Docker's static daemon runs from this attempt's own verified download, never a fixed path.
    expect(started.some((c) => c.includes(g.tools + "/docker/dockerd --config-file"))).toBe(true);
  });

  test("a daemon that was already running is never restarted when its storage fails", async () => {
    let first = true;

    const { box, commands, started } = scriptedBox([
      [
        /daemon-ping/,
        (c) => {
          if (c.includes("podman.sock")) return { output: pingOk };

          if (first) {
            first = false;

            return { output: pingOk };
          }

          return pingFail;
        },
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const d = await getDaemon(
      guestFor(box),
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    expect(d.record.method).toBe("preinstalled-running");
    expect(await d.switchStorage("failed to register layer: operation not permitted")).toBe(true);
    expect(d.record.method).toBe("podman");
    // The ladder goes on with daemons of its own, each on its own socket: the running daemon, its
    // socket and its PID file are never touched.
    expect(d.record.tries.some((t) => t.method === "preinstalled-started")).toBe(true);
    expect(started.length).toBeGreaterThan(1);
    expect(started.every((c) => !c.includes("/var/run/docker"))).toBe(true);
    expect(commands.some((c) => /pkill|killall|rm -f \/var\/run/.test(c))).toBe(false);
  });

  test("a root-only socket is reached through sudo and never chmod; the project is the attempt's own and comes down", async () => {
    const { box, commands } = scriptedBox([
      [
        /daemon-ping/,
        (c) =>
          c.includes("sudo -n")
            ? { output: pingOk }
            : {
                ok: false,
                exitCode: 1,
                output: '{"ok":false,"error":"connect EACCES /var/run/docker.sock"}',
              },
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const d = await getDaemon(
      guestFor(box),
      probeOf({ uid: "1000", user: "dev", sudo: "passwordless" }),
      10_000,
      () => {},
      "sbx-p-compose-1-abc123",
    );

    expect(d.record.method).toBe("preinstalled-running");
    expect(d.record.project).toBe("sbx-p-compose-1-abc123");
    expect(commands.some((c) => c.includes("chmod"))).toBe(false);

    const pull = d.composeCommand("pull --quiet");
    expect(pull.startsWith('sudo -n env PATH="$PATH" DOCKER_HOST="$DOCKER_HOST"')).toBe(true);
    expect(pull).toContain(
      "docker compose -p 'sbx-p-compose-1-abc123' -f compose.yaml pull --quiet",
    );

    d.projectUsed = true;
    expect(await d.down(guestFor(box), 1000)).toBe(true);
    expect(d.record.down).toBe(true);
    expect(commands.at(-1)).toContain("-p 'sbx-p-compose-1-abc123' -f compose.yaml down -v");
  });

  test("each attempt gets its own Compose project", () => {
    const a = composeProject("e2b-compose-1");
    expect(a).toMatch(/^sbx-e2b-compose-1-[0-9a-f]{6}$/);
    expect(composeProject("e2b-compose-1")).not.toBe(a);
  });
});

describe("daemon deadline (fake clock)", () => {
  /** A guest on a fake clock where a launch takes launchMs and each ping takes pingMs. */
  function slowDaemon(launchMs: number, pingMs: number) {
    let clock = 0;
    let launched = false;

    const { box } = scriptedBox([
      [
        /daemon-ping/,
        () => {
          clock += pingMs;

          // No daemon answers before the first launch.
          return launched
            ? { output: pingOk }
            : {
                ok: false,
                exitCode: 1,
                output: '{"ok":false,"error":"connect ENOENT /var/run/docker.sock"}',
              };
        },
      ],
    ]);

    box.start = async (command: string) => {
      launched = true;
      clock += launchMs;

      return { name: command };
    };

    const g = new Guest(box, new AbortController().signal, [], () => clock);
    g.pollMs = 0;
    g.mono = () => clock;

    return g;
  }

  const ladderFailure = (g: Guest) =>
    getDaemon(g, probeOf(), 10, () => {}).then(
      () => null,
      (error: Error) => error,
    );

  test("a launch that outlasts the daemon budget is not accepted, though the daemon then answers", async () => {
    const failure = await ladderFailure(slowDaemon(1000, 0));

    expect(failure instanceof StageFailure && failure.reason).toBe("no daemon method worked");
    expect(failure instanceof StageFailure && failure.detail).toContain(
      "static-rootful/default: no answer within 10 ms",
    );
  });

  test("an answer that arrives after the budget is not accepted", async () => {
    const failure = await ladderFailure(slowDaemon(0, 1000));

    expect(failure instanceof StageFailure && failure.detail).toContain(
      "static-rootful/default: no answer within 10 ms",
    );
  });

  test("an answer within the budget is accepted", async () => {
    const d = await getDaemon(slowDaemon(2, 2), probeOf(), 10, () => {});

    expect(d.record).toMatchObject({ method: "static-rootful", config: "default" });
  });
});

describe("pins and provider expiry", () => {
  test("a cache built from other pins is refused", () => {
    const current: Artifacts = {
      schema: "svc-artifacts/1",
      createdAt: "x",
      node: { sha256: node.sha256, bytes: 1, version: node.version },
      fixture: { sha256: "b".repeat(64), bytes: 1, sourceSha256: "s" },
      native: {
        sha256: "c".repeat(64),
        bytes: 1,
        postgresInputSha256: zonkyPostgres.sha256,
        redisSourceSha256: redisSource.sha256,
        redisBuild: "b",
      },
    };

    expect(stalePins(current)).toEqual([]);
    expect(stalePins({ ...current, node: { ...current.node, sha256: "d".repeat(64) } })).toEqual([
      "the Node tarball",
    ]);
    expect(
      stalePins({
        ...current,
        native: {
          ...current.native,
          postgresInputSha256: "e".repeat(64),
          redisSourceSha256: "f".repeat(64),
        },
      }),
    ).toEqual(["the Postgres binaries", "the Redis source"]);
  });

  test("adapters that can end a lost sandbox on their own are told to", () => {
    expect(servicesFactory("superserve", 60_000, null)).toEqual({
      autoPauseMs: 960_000,
      autoDeleteMs: 0,
    });
    expect(servicesFactory("boat", 60_000, null)).toEqual({ ttlSeconds: 960 });
    expect(servicesFactory("modal", 60_000, "vm")).toEqual({ runtime: "vm" });
    expect(servicesFactory("modal", 60_000, null)).toBeUndefined();
    expect(servicesFactory("upstash", 60_000, null)).toBeUndefined();
  });
});

describe("journal read errors", () => {
  const runFile = {
    id: "r1",
    ownerLabel: "r1-abcd",
    sdkCommit: "a",
    startedAt: "x",
    endedAt: null,
    location: "t",
    settings: {},
    artifacts: { node: "n", fixture: "f", native: "b" },
    providers: [],
  };

  test("summary fails on an attempt file it cannot read instead of publishing nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svc-read-"));

    try {
      await writeFile(join(dir, "run.json"), JSON.stringify(runFile));
      await mkdir(join(dir, "services-attempts.jsonl"));
      await expect(servicesCommand(["summary", "--out", dir])).rejects.toThrow(/EISDIR/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sweep counts an unreadable ownership journal as unchecked and exits nonzero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svc-read-"));
    const before = process.exitCode;

    try {
      await writeFile(join(dir, "run.json"), JSON.stringify(runFile));
      await mkdir(join(dir, "owned.jsonl"));
      await servicesCommand(["sweep", "--out", dir, "--run", "r1"]);
      expect(process.exitCode).toBe(1);
      expect(await readFile(join(dir, "notes.jsonl"), "utf8")).toContain("journal-unreadable");
    } finally {
      process.exitCode = before;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("daemons this attempt did not launch", () => {
  /** A sandbox with an unrelated Docker daemon: its default socket exists but does not answer. */
  const unrelatedProbe = probeOf({
    uid: "1000",
    user: "dev",
    sudo: "passwordless",
    dockerd: "yes",
    newuidmap: "yes",
    subuid: "yes",
    podman: "podman version 5.0.0",
  });

  const unresponsive = {
    ok: false,
    exitCode: 1,
    output: '{"ok":false,"error":"context deadline exceeded"}',
  };

  test.each([
    ["the first rung finds the default socket unresponsive", "none"],
    ["storage fails on the daemon that was already running", "running"],
    ["storage fails on a daemon this attempt launched", "launched"],
  ] as const)("%s: only this attempt's own daemons are ever stopped", async (_name, answers) => {
    let starts = 0;
    let asFound = true;

    const { box, commands, started } = scriptedBox([
      [
        /daemon-ping/,
        (c) => {
          if (c.includes("podman.sock")) return { output: pingOk };

          if (c.includes("/var/run/docker.sock")) {
            const first = asFound;
            asFound = false;

            return answers === "running" && first ? { output: pingOk } : unresponsive;
          }

          return answers === "launched" && starts === 1 ? { output: pingOk } : unresponsive;
        },
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    box.start = async (command: string) => {
      starts++;
      started.push(command);

      return { name: command };
    };

    const g = guestFor(box);
    const d = await getDaemon(g, unrelatedProbe, 10_000, () => {});

    if (answers !== "none") {
      expect(d.record.method).toBe(
        answers === "running" ? "preinstalled-running" : "preinstalled-started",
      );
      expect(
        await d.switchStorage("error creating overlay mount to /x/merged: invalid argument"),
      ).toBe(true);
    }

    expect(d.record.method).toBe("podman");
    // Every fallback family ran: the rootful methods, rootless and podman.
    expect(new Set(d.record.tries.map((t) => t.method))).toEqual(
      new Set([
        "preinstalled-running",
        "preinstalled-started",
        "static-rootful",
        "rootless",
        "podman",
      ]),
    );

    // An unresponsive socket says nothing about Docker here.
    if (answers === "none")
      expect(d.record.tries.find((t) => t.config === "as-found")?.conclusive).toBe(false);

    // Nothing is killed by name and no default PID file or socket is removed.
    expect(
      commands.some((c) => /pkill|killall|rm -f \/var\/|docker\.pid|containerd\.pid/.test(c)),
    ).toBe(false);

    // Every signal goes to one launch's recorded PID, once for each daemon this attempt launched
    // and gave up.
    const stops = commands.filter((c) => /\bkill\b/.test(c));
    expect(stops.every((c) => c.includes(`cat ${g.tools}/`) && c.includes("/launch.pid"))).toBe(
      true,
    );
    expect(stops).toHaveLength(
      d.record.tries.filter((t) => !t.ok && t.config !== "as-found" && t.config !== "fetch").length,
    );

    // Every daemon serves its own socket, PID and state under the attempt's tool directory.
    for (const s of started) {
      expect(s).not.toContain("/var/run/docker");
      expect(s).toContain(`echo $$ > ${g.tools}/`);
    }
  });

  test("stopping a launch signals its own process tree and nothing else, not even a reused PID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svc-stop-"));
    const other = await mkdtemp(join(tmpdir(), "svc-other-"));
    // Stands in for a daemon this attempt did not start.
    const unrelated = spawn("sleep", ["300"], { stdio: "ignore" });
    // A launched daemon with a child of its own; its command line names its directory.
    const launched = spawn("sh", ["-c", `sleep 300; : ${dir}`], { stdio: "ignore" });
    const exited = new Promise((resolve) => launched.once("exit", resolve));

    const sh = (script: string) =>
      new Promise<void>((resolve, reject) =>
        execFile("sh", ["-c", script], (error) => (error ? reject(error) : resolve())),
      );

    const gone = async (pid: string) => {
      for (let i = 0; i < 40; i++) {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);

        if (stat === null || /\) [ZX] /.test(stat)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      return false;
    };

    try {
      let child = "";

      for (let i = 0; i < 40 && !child; i++) {
        child = (
          await readFile(`/proc/${launched.pid}/task/${launched.pid}/children`, "utf8")
        ).trim();

        if (!child) await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(child).toMatch(/^\d+$/);

      // A launch file holding a PID this attempt never launched stops nothing.
      await writeFile(join(other, "launch.pid"), String(unrelated.pid));
      await sh(stopTree(other));
      await writeFile(join(dir, "launch.pid"), String(launched.pid));
      await sh(stopTree(dir));
      await exited;

      expect(await gone(child)).toBe(true);
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
    } finally {
      unrelated.kill("SIGKILL");
      launched.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("compose cleanup obligation", () => {
  const daemonOf = (launched: boolean, down: boolean | null, projectUsed = true) => {
    const base = record({ provider: "p", path: "compose", attempt: 1, up: 1 }).daemon;

    if (!base) throw new Error("compose record without a daemon");

    return { projectUsed, record: { ...base, launched, down } };
  };

  test("the project obligation is tracked apart from the sandbox, and only its own down or a launched daemon resolves it", () => {
    expect(projectCleanupOf(daemonOf(false, true))).toBe("down");
    expect(projectCleanupOf(daemonOf(false, false))).toBe("open");
    // A cleanup down that never finished is no proof either.
    expect(projectCleanupOf(daemonOf(false, null))).toBe("open");
    expect(projectCleanupOf(daemonOf(true, false))).toBe("with-sandbox");
    expect(projectCleanupOf(daemonOf(false, null, false))).toBe("none");
    expect(projectCleanupOf(null)).toBe("none");

    expect(cleanupStatus(true, "down")).toBe("confirmed");
    expect(cleanupStatus(true, "with-sandbox")).toBe("confirmed");
    expect(cleanupStatus(false, "with-sandbox")).toBe("unconfirmed");
    expect(cleanupStatus(false, "down")).toBe("unconfirmed");
    // A confirmed sandbox deletion never resolves a project left on a daemon that outlives it.
    expect(cleanupStatus(true, "open")).toBe("unconfirmed");
  });

  test("a project that does not come down holds its daemon: down is retried once and no other rung runs", async () => {
    const { box, commands, started } = scriptedBox([
      [/ down -v/, () => ({ ok: false, exitCode: 1, output: "context deadline exceeded" })],
      [/daemon-ping/, () => ({ output: pingOk })],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const d = await getDaemon(
      guestFor(box),
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      10_000,
      () => {},
      "sbx-p-compose-1-abc123",
    );

    d.projectUsed = true;
    expect(
      await d.switchStorage("error creating overlay mount to /x/merged: invalid argument"),
    ).toBe(false);
    expect(commands.filter((c) => c.includes(" down -v"))).toHaveLength(2);
    expect(started).toEqual([]);
    expect(d.record).toMatchObject({
      method: "preinstalled-running",
      down: false,
      launched: false,
    });
    expect(projectCleanupOf(d)).toBe("open");
  });

  test("the summary keeps cleanup apart from the outcome", () => {
    const run = {
      id: "r1",
      sdkCommit: "a",
      startedAt: "x",
      endedAt: null,
      location: "t",
      settings: {},
      artifacts: { node: "n", fixture: "f", native: "b" },
    };

    const site = servicesSiteData({
      records: [
        record({ provider: "p", path: "compose", attempt: 1, up: 20_000, cleanup: "unconfirmed" }),
        record({ provider: "p", path: "compose", attempt: 2, up: 21_000 }),
      ],
      runs: [run],
    });

    const p = site.providers[0];
    expect(p?.compose).toMatchObject({ status: "measured", green: 2 });
    expect(p?.compose.cleanupUnconfirmed).toEqual([
      { runId: "r1", attempt: 1, attemptId: "p-compose-1" },
    ]);
    expect(summaryMarkdown(site)).toContain(
      "## Cleanup unconfirmed\n\n- p compose #1: p-compose-1",
    );
  });
});

describe("readiness deadlines", () => {
  test("a daemon already on the default socket that answers after the budget is not used", async () => {
    let clock = 0;

    const { box } = scriptedBox([
      [
        /daemon-ping/,
        () => {
          clock += 1000;

          return { output: pingOk };
        },
      ],
    ]);

    const g = new Guest(box, new AbortController().signal, [], () => clock);
    g.pollMs = 0;
    g.mono = () => clock;
    const kept: DaemonRecord[] = [];

    const failure = await getDaemon(g, probeOf(), 10, (d) => {
      kept.push(d.record);
    }).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(StageFailure);
    expect(kept[0]?.tries.find((t) => t.config === "as-found")).toMatchObject({
      ok: false,
      error: "answered only after 10 ms",
      conclusive: false,
    });
  });

  test("a launch that never returns ends its config at the deadline, the ladder goes on, and a late return is stopped", async () => {
    const pending: { command: string; resolve: () => void }[] = [];

    const { box, commands } = scriptedBox([
      [
        /daemon-ping/,
        (c) =>
          c.includes("podman.sock")
            ? { output: pingOk }
            : {
                ok: false,
                exitCode: 1,
                output: '{"ok":false,"error":"connect ENOENT /var/run/docker.sock"}',
              },
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    box.start = (command: string) =>
      command.includes("podman.sock")
        ? Promise.resolve({ name: command })
        : new Promise((resolve) => {
            pending.push({ command, resolve: () => resolve({ name: command }) });
          });

    const g = new Guest(box, new AbortController().signal, [], () => 0);
    g.pollMs = 0;
    g.mono = () => 0;

    const d = await getDaemon(
      g,
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      20,
      () => {},
    );

    expect(d.record.method).toBe("podman");
    expect(
      d.record.tries.find((t) => t.method === "preinstalled-started" && t.config === "default")
        ?.error,
    ).toBe("launch did not return within 20 ms");

    const stopsOf = (dir: string) =>
      commands.filter((c) => /\bkill\b/.test(c) && c.includes(`${dir}/launch.pid`)).length;

    const dir = `${g.tools}/preinstalled-started-default`;
    expect(stopsOf(dir)).toBe(1);
    pending[0]?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopsOf(dir)).toBe(2);
  });
});

describe("recovery notes", () => {
  test("sweep goes on when notes.jsonl cannot be written, and says so on stderr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "svc-notes-"));
    const before = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await writeFile(
        join(dir, "run.json"),
        JSON.stringify({
          id: "r1",
          ownerLabel: "r1-abcd",
          sdkCommit: "a",
          startedAt: "x",
          endedAt: null,
          location: "t",
          settings: {},
          artifacts: { node: "n", fixture: "f", native: "b" },
          providers: [],
        }),
      );
      await mkdir(join(dir, "owned.jsonl"));
      await mkdir(join(dir, "notes.jsonl"));
      await servicesCommand(["sweep", "--out", dir, "--run", "r1"]);
      expect(process.exitCode).toBe(1);
      expect(stderr.mock.calls.some(([text]) => String(text).includes("Could not write"))).toBe(
        true,
      );
      expect(stdout.mock.calls.some(([text]) => String(text).startsWith("Swept 0 providers"))).toBe(
        true,
      );
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      process.exitCode = before;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("network namespace ownership", () => {
  const unanswered = {
    ok: false,
    exitCode: 1,
    output: '{"ok":false,"error":"context deadline exceeded"}',
  };

  test("a dockerd or containerd this attempt did not start keeps every rootful launch off, inconclusively", async () => {
    const { box, started } = scriptedBox([
      [/SCANNED \$n/, () => ({ output: "812:dockerd\n813:containerd\nSCANNED 40" })],
      [/daemon-ping/, (c) => (c.includes("podman.sock") ? { output: pingOk } : unanswered)],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const d = await getDaemon(
      guestFor(box),
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    expect(d.record.method).toBe("podman");
    expect(started.some((c) => c.includes("dockerd"))).toBe(false);
    expect(d.record.tries.filter((t) => t.config === "ownership")).toMatchObject([
      {
        method: "preinstalled-started",
        ok: false,
        error: "another daemon owns the network namespace (812:dockerd, 813:containerd)",
        conclusive: false,
      },
      { method: "static-rootful", ok: false, conclusive: false },
    ]);
    // Docker's static bundle is not even fetched for a launch that cannot run.
    expect(d.record.tries.some((t) => t.config === "fetch")).toBe(false);
  });

  test("a scan that cannot finish keeps rootful launches off too", async () => {
    const { box, started } = scriptedBox([
      [/SCANNED \$n/, () => ({ ok: false, exitCode: 1, output: "" })],
      [/daemon-ping/, (c) => (c.includes("podman.sock") ? { output: pingOk } : unanswered)],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const d = await getDaemon(
      guestFor(box),
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    expect(d.record.method).toBe("podman");
    expect(started.some((c) => c.includes("dockerd"))).toBe(false);
    expect(d.record.tries.find((t) => t.config === "ownership")?.error).toBe(
      "could not check for another daemon in the network namespace",
    );
  });

  test("every dockerd launch reads a config file of its own, never the image's", async () => {
    const { box, started } = scriptedBox([
      [/daemon-ping/, (c) => (c.includes("podman.sock") ? { output: pingOk } : unanswered)],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const g = guestFor(box);

    await getDaemon(
      g,
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    const dockerd = started.filter((c) => c.includes("dockerd"));
    expect(dockerd.length).toBeGreaterThan(0);

    for (const c of dockerd) {
      const dir = /mkdir -p -m 700 (\S+) &&/.exec(c)?.[1] ?? "";
      expect(dir.startsWith(`${g.tools}/`)).toBe(true);
      expect(c).toContain(`printf '{}' > ${dir}/daemon.json`);
      expect(c).toContain(`--config-file ${dir}/daemon.json`);
    }
  });
});

describe("stalled readiness calls", () => {
  test("a stalled as-found ping and stalled liveness checks are aborted at the deadline, and the ladder reaches a working rung", async () => {
    const aborted: string[] = [];

    const { box } = scriptedBox([
      [
        /daemon-ping/,
        (c) =>
          c.includes("podman.sock")
            ? { output: pingOk }
            : {
                ok: false,
                exitCode: 1,
                output: '{"ok":false,"error":"connect ENOENT /tmp/x/docker.sock"}',
              },
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const run = box.run;

    const stall = (name: string, options: RunOptions) =>
      new Promise<RunResult>((_, reject) => {
        options.signal?.addEventListener("abort", () => {
          aborted.push(name);
          reject(new Error("aborted"));
        });
      });

    box.run = (command: string, options: RunOptions) =>
      command.includes("daemon-ping") && command.includes("/var/run/docker.sock")
        ? stall("as-found", options)
        : command.includes("echo DEAD")
          ? stall("liveness", options)
          : run(command, options);

    const g = new Guest(box, new AbortController().signal, [], Date.now);
    g.pollMs = 0;
    const startedAt = performance.now();

    const d = await getDaemon(g, probeOf({ podman: "podman version 5.0.0" }), 25, () => {});

    expect(d.record.method).toBe("podman");
    expect(d.record.tries.find((t) => t.config === "as-found")).toMatchObject({
      ok: false,
      error: "no answer within 25 ms",
      conclusive: false,
    });
    expect(aborted).toContain("as-found");
    expect(aborted).toContain("liveness");
    // Seven 25 ms budgets (as-found, five static configs, podman) and nothing waiting past them.
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});

describe("one search path", () => {
  test("the probe and every launch search one PATH with the system sbin directories, sudo env included", async () => {
    expect(probeScript).not.toMatch(/PATH=/);

    const { box, started } = scriptedBox([
      [
        /daemon-ping/,
        (c) =>
          c.includes("podman.sock")
            ? { output: pingOk }
            : { ok: false, exitCode: 1, output: '{"ok":false,"error":"connect ENOENT x"}' },
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const g = guestFor(box);

    // A sudo guest whose stock dockerd lives only in sbin.
    await getDaemon(
      g,
      probeOf({
        uid: "1000",
        user: "dev",
        sudo: "passwordless",
        dockerd: "yes",
        podman: "podman version 5.0.0",
      }),
      10_000,
      () => {},
    );

    const launch = started.find((c) => c.includes("preinstalled-started-default"));
    expect(launch).toContain(`"$PATH":${systemBin}; `);
    expect(launch).toContain('sudo -n env PATH="$PATH" dockerd ');

    const sh = (script: string) =>
      new Promise<string>((resolve, reject) =>
        execFile("sh", ["-c", script], { env: { PATH: "/usr/bin:/bin" } }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        ),
      );

    // From a login PATH without sbin, the guest's PATH has every system sbin directory.
    const path = (await sh(`${g.prelude()}printf %s "$PATH"`)).split(":");

    for (const dir of systemBin.split(":")) expect(path).toContain(dir);

    // And `env PATH="$PATH"`, as the sudo launch runs it, resolves a binary that is only in sbin.
    const only = (await readdir("/usr/sbin").catch(() => [])).find(
      (name) => !existsSync(`/usr/bin/${name}`) && !existsSync(`/bin/${name}`),
    );

    if (only)
      expect((await sh(`${g.prelude()}env PATH="$PATH" sh -c 'command -v ${only}'`)).trim()).toBe(
        `/usr/sbin/${only}`,
      );
  });
});

describe("measurement conditions", () => {
  const run = {
    id: "r1",
    sdkCommit: "a",
    startedAt: "x",
    endedAt: null,
    location: "evo-1",
    settings: {},
    conditions: { attemptTimeoutMs: 1_500_000, daemonReadyMs: 45_000 },
    artifacts: { node: "n", fixture: "f", native: "b" },
  };

  const records = [
    record({ provider: "p", path: "native", attempt: 1, up: 2000 }),
    { ...record({ provider: "p", path: "native", attempt: 2, up: 8000 }), runId: "r2" },
  ];

  test("runs from another runner location or with other timing settings are never pooled", () => {
    expect(() =>
      servicesSiteData({ records, runs: [run, { ...run, id: "r2", location: "evo-2" }] }),
    ).toThrow("runner location or timing settings");
    expect(() =>
      servicesSiteData({
        records,
        runs: [run, { ...run, id: "r2", conditions: { ...run.conditions, daemonReadyMs: 10_000 } }],
      }),
    ).toThrow("daemon 10000 ms");
    expect(() =>
      servicesSiteData({ records, runs: [run, { ...run, id: "r2", conditions: null }] }),
    ).toThrow("timing not recorded");
    expect(servicesSiteData({ records, runs: [run, { ...run, id: "r2" }] }).providers).toHaveLength(
      1,
    );
  });
});

describe("open Compose projects in recovery", () => {
  const runFile = {
    id: "r1",
    ownerLabel: "r1-abcd",
    sdkCommit: "a",
    startedAt: "x",
    endedAt: null,
    location: "t",
    settings: {},
    artifacts: { node: "n", fixture: "f", native: "b" },
    providers: [],
  };

  /**
   * Sol's case: both `down` tries failed on a daemon that was already running and the destroy
   * timed out; a later reconciliation confirmed the sandbox gone.
   */
  const leftOn = (projectCleanup: "open" | "with-sandbox"): AttemptRecord => {
    const base = record({
      provider: "p",
      path: "compose",
      attempt: 1,
      up: null,
      method: "preinstalled-running",
    });

    return {
      ...base,
      daemon: base.daemon
        ? { ...base.daemon, method: "preinstalled-running", launched: false, down: false }
        : null,
      phases: [
        { name: "destroy", startedAt: 0, endedAt: 1, ok: false, exitCode: null, timedOut: false },
      ],
      cleanup: "unconfirmed",
      projectCleanup,
    };
  };

  const sweepWith = async (row: AttemptRecord) => {
    const dir = await mkdtemp(join(tmpdir(), "svc-project-"));
    const before = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await writeFile(join(dir, "run.json"), JSON.stringify(runFile));
      await writeFile(join(dir, "services-attempts.jsonl"), `${JSON.stringify(row)}\n`);
      await servicesCommand(["sweep", "--out", dir, "--run", "r1"]);

      return {
        exitCode: process.exitCode,
        stderr: stderr.mock.calls.map(([text]) => String(text)).join(""),
        stdout: stdout.mock.calls.map(([text]) => String(text)).join(""),
      };
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      process.exitCode = before;
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("a confirmed sandbox deletion never clears a project on a daemon that outlived it: sweep names it and exits nonzero", async () => {
    const open = await sweepWith(leftOn("open"));
    expect(open.exitCode).toBe(1);
    expect(open.stderr).toContain("Compose project cleanup unresolved for p-compose-1");
    expect(open.stdout).toContain('"openProjects":1');

    // The same failed down on a daemon launched inside the sandbox went with it.
    const launched = await sweepWith(leftOn("with-sandbox"));
    expect(launched.exitCode).not.toBe(1);
    expect(launched.stdout).toContain('"openProjects":0');
  });
});

describe("shared-network daemons one at a time", () => {
  const unanswered = { ok: false, exitCode: 1, output: '{"ok":false,"error":"connect ENOENT x"}' };

  test("a rootful launch whose acknowledgement stalls and whose stop is not confirmed blocks every later rootful config", async () => {
    const { box, commands, started } = scriptedBox([
      [/kill -TERM/, () => ({ output: "NOPID" })],
      [/daemon-ping/, (c) => (c.includes("podman.sock") ? { output: pingOk } : unanswered)],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    box.start = (command: string) => {
      started.push(command);

      // The first rootful daemon spawns but its acknowledgement never comes back.
      return command.includes("podman.sock")
        ? Promise.resolve({ name: command })
        : new Promise(() => {});
    };

    const g = new Guest(box, new AbortController().signal, [], () => 0);
    g.pollMs = 0;
    g.mono = () => 0;

    const d = await getDaemon(
      g,
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      20,
      () => {},
    );

    expect(d.record.method).toBe("podman");
    expect(started.filter((c) => c.includes("dockerd"))).toHaveLength(1);
    expect(
      d.record.tries
        .filter((t) => t.config === "ownership")
        .map((t) => [t.method, t.ok, t.conclusive, t.error]),
    ).toEqual([
      [
        "preinstalled-started",
        false,
        false,
        "the preinstalled-started/default launch did not return",
      ],
      ["static-rootful", false, false, "the preinstalled-started/default launch did not return"],
    ]);
    // Scanned on entering the method and again right before its one launch; never after it.
    expect(commands.filter((c) => c.includes('"SCANNED $n"'))).toHaveLength(2);
  });

  test("a storage fallback whose stop is not confirmed starts no other rootful daemon", async () => {
    let starts = 0;

    const { box, started } = scriptedBox([
      [/kill -TERM/, () => ({ output: "SURVIVED" })],
      [
        /daemon-ping/,
        (c) => (c.includes("podman.sock") || starts === 1 ? { output: pingOk } : unanswered),
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    box.start = async (command: string) => {
      starts++;
      started.push(command);

      return { name: command };
    };

    const d = await getDaemon(
      guestFor(box),
      probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
      10_000,
      () => {},
    );

    expect(d.record.method).toBe("preinstalled-started");
    expect(
      await d.switchStorage("error creating overlay mount to /x/merged: invalid argument"),
    ).toBe(true);
    expect(d.record.method).toBe("podman");
    expect(started.filter((c) => c.includes("dockerd"))).toHaveLength(1);
    expect(d.record.tries.filter((t) => t.config === "ownership").map((t) => t.error)).toEqual([
      "the preinstalled-started/default daemon was not confirmed stopped",
      "the preinstalled-started/default daemon was not confirmed stopped",
    ]);
  });

  test("a scan without its exact completion marker, or with an unreadable process, blocks rootful launches", async () => {
    for (const output of ["SCANNED", "SCANNED 0", "UNREADABLE:77\nSCANNED 12"]) {
      const { box, started } = scriptedBox([
        [/SCANNED \$n/, () => ({ output })],
        [/daemon-ping/, (c) => (c.includes("podman.sock") ? { output: pingOk } : unanswered)],
        [/docker compose version/, () => ({ output: "2.40.0" })],
      ]);

      const d = await getDaemon(
        guestFor(box),
        probeOf({ dockerd: "yes", podman: "podman version 5.0.0" }),
        10_000,
        () => {},
      );

      expect(started.some((c) => c.includes("dockerd"))).toBe(false);
      expect(d.record.tries.find((t) => t.config === "ownership")?.error).toContain(
        "could not check for another daemon",
      );
    }
  });

  test("the scan runs at launch privilege", async () => {
    const { box, commands } = scriptedBox([
      [/daemon-ping/, (c) => (c.includes("podman.sock") ? { output: pingOk } : unanswered)],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    await getDaemon(
      guestFor(box),
      probeOf({
        uid: "1000",
        user: "dev",
        sudo: "passwordless",
        dockerd: "yes",
        podman: "podman version 5.0.0",
      }),
      10_000,
      () => {},
    );

    const scans = commands.filter((c) => c.includes('"SCANNED $n"'));
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((c) => c.includes("sudo -n sh -c "))).toBe(true);
  });
});

describe("project claims before up", () => {
  test("a claim is journaled before up, and its own down or the sandbox resolves it", async () => {
    const events: string[] = [];

    const { box } = scriptedBox([
      [/daemon-ping/, () => ({ output: pingOk })],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    const d = await getDaemon(guestFor(box), probeOf(), 10_000, () => {}, "sbx-p-compose-1-abc123");
    d.owner = { provider: "p", attemptId: "p-compose-1", sandboxId: "sb-1" };

    d.onProject = async (event) => {
      events.push(`${event.state} ${event.provenance} ${event.daemon} ${event.sandboxId}`);
    };

    await d.claim();
    expect(events).toEqual(["pending as-found preinstalled-running/as-found sb-1"]);
    expect(await d.down(guestFor(box), 1000)).toBe(true);
    expect(events.at(-1)).toBe("down as-found preinstalled-running/as-found sb-1");

    // A claim that cannot be journaled never lets up run.
    d.onProject = async () => {
      throw new Error("EROFS");
    };

    await expect(d.claim()).rejects.toThrow("EROFS");
  });

  test("only a daemon launched inside the sandbox is resolved by its deletion", async () => {
    const events: string[] = [];
    let starts = 0;

    const { box } = scriptedBox([
      [/ down -v/, () => ({ ok: false, exitCode: 1, output: "timed out" })],
      [
        /daemon-ping/,
        (c) =>
          c.includes("/var/run/docker.sock") || starts === 0
            ? { ok: false, exitCode: 1, output: "x" }
            : { output: pingOk },
      ],
      [/docker compose version/, () => ({ output: "2.40.0" })],
    ]);

    box.start = async (command: string) => {
      starts++;

      return { name: command };
    };

    const d = await getDaemon(guestFor(box), probeOf({ dockerd: "yes" }), 10_000, () => {});
    d.owner = { provider: "p", attemptId: "p-compose-1", sandboxId: "sb-1" };

    d.onProject = async (event) => {
      events.push(`${event.state} ${event.provenance}`);
    };

    await d.claim();
    expect(await d.down(guestFor(box), 1000)).toBe(false);
    await d.releaseWithSandbox();
    expect(events).toEqual(["pending launched", "with-sandbox launched"]);
  });
});

describe("project claims in recovery", () => {
  const runFile = {
    id: "r1",
    ownerLabel: "r1-abcd",
    sdkCommit: "a",
    startedAt: "x",
    endedAt: null,
    location: "t",
    settings: {},
    artifacts: { node: "n", fixture: "f", native: "b" },
    providers: [],
  };

  const claim = (state: "pending" | "down") => ({
    provider: "p",
    attemptId: "p-compose-1",
    project: "sbx-p-compose-1-abc123",
    daemon: "preinstalled-running/as-found",
    provenance: "as-found",
    sandboxId: "sb-1",
    state,
  });

  const sweepWith = async (claims: object[]) => {
    const dir = await mkdtemp(join(tmpdir(), "svc-claims-"));
    const before = process.exitCode;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await writeFile(join(dir, "run.json"), JSON.stringify(runFile));
      // A runner that died mid-attempt: the create was submitted and its sandbox journaled, but
      // no attempt row was ever written.
      await writeFile(
        join(dir, "submissions.jsonl"),
        `${JSON.stringify({ provider: "p", attemptId: "p-compose-1" })}\n`,
      );
      await writeFile(
        join(dir, "owned.jsonl"),
        `${JSON.stringify({ provider: "p", id: "sb-1", attemptId: "p-compose-1" })}\n`,
      );
      await writeFile(
        join(dir, "projects.jsonl"),
        claims.map((c) => `${JSON.stringify(c)}\n`).join(""),
      );
      await servicesCommand(["sweep", "--out", dir, "--run", "r1"]);

      return {
        exitCode: process.exitCode,
        stderr: stderr.mock.calls.map(([text]) => String(text)).join(""),
        stdout: stdout.mock.calls.map(([text]) => String(text)).join(""),
      };
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      process.exitCode = before;
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("a submitted compose attempt with an owned ID and no attempt row: its claim keeps sweep at exit 1", async () => {
    const open = await sweepWith([claim("pending")]);
    expect(open.exitCode).toBe(1);
    expect(open.stderr).toContain("Compose project cleanup unresolved for p-compose-1");
    expect(open.stdout).toContain('"openProjects":1');

    // A claim its own down resolved is no obligation.
    const resolved = await sweepWith([claim("pending"), claim("down")]);
    expect(resolved.stdout).toContain('"openProjects":0');
    expect(resolved.stderr).not.toContain("Compose project cleanup unresolved");
  });
});

describe("runs that share attempt ordinals", () => {
  const run = (id: string) => ({
    id,
    sdkCommit: "a",
    startedAt: "x",
    endedAt: null,
    location: "evo-1",
    settings: {},
    artifacts: { node: "n", fixture: "f", native: "b" },
  });

  test("two Boat batches with the same attempt ID keep both rows apart", () => {
    const refused = record({ provider: "boat", path: "compose", attempt: 1, up: null });

    const upload: AttemptRecord = {
      ...record({ provider: "boat", path: "compose", attempt: 1, up: null }),
      runId: "r2",
      daemon: null,
      outcome: { kind: "failed", stage: "upload", reason: "joining failed", detail: "" },
    };

    const site = servicesSiteData({ records: [refused, upload], runs: [run("r1"), run("r2")] });
    const compose = site.providers[0]?.compose;

    expect(compose?.attempts).toBe(2);
    expect(compose?.unsupported.map((u) => `${u.runId}/${u.attemptId}`)).toEqual([
      "r1/boat-compose-1",
    ]);
    expect(compose?.failures).toEqual([
      {
        runId: "r2",
        attempt: 1,
        attemptId: "boat-compose-1",
        stage: "upload",
        reason: "joining failed",
      },
    ]);
    expect(summaryMarkdown(site)).toContain("- boat compose #1 (r2): upload: joining failed");
  });
});

describe("placement", () => {
  const run = (id: string, region: string | null, location = "evo-1") => ({
    id,
    sdkCommit: "a",
    startedAt: "x",
    endedAt: null,
    location,
    settings: {},
    conditions: {
      attemptTimeoutMs: 1_500_000,
      daemonReadyMs: 45_000,
      placement: { modal: { MODAL_SANDBOX_REGION: region } },
    },
    artifacts: { node: "n", fixture: "f", native: "b" },
  });

  const records = [
    record({ provider: "modal", path: "native", attempt: 1, up: 2000 }),
    { ...record({ provider: "modal", path: "native", attempt: 1, up: 8000 }), runId: "r2" },
  ];

  test("runs that placed a provider differently are never pooled", () => {
    expect(() =>
      servicesSiteData({ records, runs: [run("r1", "us-east"), run("r2", "eu-west")] }),
    ).toThrow("modal was placed differently in r1");
    expect(
      servicesSiteData({ records, runs: [run("r1", "us-east"), run("r2", "us-east")] }).providers,
    ).toHaveLength(1);
  });

  test("a run without a runner location is refused", () => {
    expect(() =>
      servicesSiteData({ records, runs: [run("r1", null, "unknown"), run("r2", null, "unknown")] }),
    ).toThrow("have no runner location");
  });
});

describe("run disposition", () => {
  const runFile = {
    id: "r1",
    ownerLabel: "r1-abcd",
    sdkCommit: "a",
    startedAt: "x",
    endedAt: null,
    location: "t",
    settings: {},
    artifacts: { node: "n", fixture: "f", native: "b" },
    providers: ["p"],
    plan: { paths: ["compose", "native"], attempts: 1 },
  };

  const folder = async (disposition: string) => {
    const dir = await mkdtemp(join(tmpdir(), "svc-disposition-"));
    await writeFile(join(dir, "run.json"), JSON.stringify({ ...runFile, disposition }));
    await writeFile(
      join(dir, "services-attempts.jsonl"),
      `${JSON.stringify(record({ provider: "p", path: "native", attempt: 1, up: 2000 }))}\n`,
    );

    return dir;
  };

  test("summary refuses a run that did not complete or is missing planned attempts", async () => {
    for (const disposition of ["running", "complete", "stopped"]) {
      const dir = await folder(disposition);

      try {
        await expect(servicesCommand(["summary", "--out", dir])).rejects.toThrow(
          `Not every run completed: r1 (disposition ${disposition}, 1 planned attempts without a result)`,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  test("--partial publishes what ran and lists what did not", async () => {
    const dir = await folder("stopped");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await servicesCommand(["summary", "--out", dir, "--partial"]);
      const site = JSON.parse(await readFile(join(dir, "services.json"), "utf8"));
      expect(site.partial.missing).toEqual([
        { runId: "r1", provider: "p", path: "compose", attempt: 1 },
      ]);
      expect(await readFile(join(dir, "summary.md"), "utf8")).toContain(
        "## Did not complete\n\n- r1 (disposition stopped, 1 planned attempts without a result)\n- p compose #1 (r1): no result",
      );
    } finally {
      stdout.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * One services attempt on a fresh sandbox: create, probe the guest, upload Node and the fixture,
 * bring up Postgres 16 and Redis 7 by one path, wait until both answer, run the fixture's
 * integration tests, and delete the sandbox whatever happened.
 *
 * compose: get a Docker-API daemon by the first method that works (running daemon, the image's
 *          dockerd, Docker's static binaries fetched by hash, rootless Docker, podman's service),
 *          then `compose pull` and `compose up -d` with the pinned image digests.
 * native:  upload the pinned bundle (Zonky Postgres 16.16, static redis-server 7.4.12) and start
 *          both as plain processes; Postgres runs as uid 65534 when the sandbox user is root.
 *
 * Both paths share the readiness check (Postgres answers SELECT 1, Redis answers PING) and the tests.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSandbox,
  SandboxError,
  type RunOptions,
  type RunResult,
  type Sandbox,
  type StartOptions,
} from "@opencoredev/sandbox-sdk";
import type { AttemptApp } from "../realistic/apps.js";
import { uploadArtifact, type UploadBox } from "../realistic/prepare.js";
import type { SlotProvider } from "../realistic/slots.js";
import { z } from "zod";
import { quote } from "../workloads.js";
import type { Artifacts } from "./artifacts.js";
import { composePlugin, dockerRootlessExtras, dockerStatic, expectedTests } from "./pins.js";
import { canBeRoot, parseProbe, probeScript, rootlessPrerequisites, type Probe } from "./probe.js";
import {
  attemptSchemaVersion,
  outsideSandbox,
  ownershipUnverified,
  type AttemptRecord,
  type DaemonMethod,
  type DaemonRecord,
  type DaemonTry,
  type Metrics,
  type Outcome,
  type ProjectCleanup,
  type ProjectEvent,
  type Phase,
  type ServicePath,
  type Stage,
} from "./record.js";

const fetchScript = readFileSync(new URL("./guest/fetch.mjs", import.meta.url), "utf8");
const pingScript = readFileSync(new URL("./guest/daemon-ping.mjs", import.meta.url), "utf8");
const portsScript = readFileSync(new URL("./guest/ports-free.mjs", import.meta.url), "utf8");

/**
 * Ports both paths serve on. Not the defaults (5432, 6379), so a server the image already runs can
 * never answer for ours; the attempt also refuses to start when anything already answers on them.
 */
export const servicePorts = { postgres: 15432, redis: 16379 } as const;

/** Guest layout. /tmp is world-writable everywhere, so uid 65534 can reach the Postgres files. */
export const guest = {
  root: "/tmp/sbx-svc",
  app: "/workspace/svc/app",
} as const;

export interface ServicesPlan {
  runId: string;
  /** The run's unique ownership label value (`sandbox-bench-run`), from run.json. */
  ownerLabel: string;
  attemptId: string;
  attempt: number;
  path: ServicePath;
  track: string;
  entry: SlotProvider;
  artifacts: Artifacts;
  /** Aborts the attempt; deletion still runs with its own deadline. */
  timeoutMs: number;
  /** Service ports; default `servicePorts`. Both paths use the same ones. */
  ports?: { postgres: number; redis: number };
  /** How long the daemon may take to answer per configuration. Default 45 s. */
  daemonReadyMs?: number;
  /** How long past `timeoutMs` cleanup waits for steps that ignore the abort. Default 30 s. */
  deadlineGraceMs?: number;
}

export interface ServicesEnvironment {
  /** The artifact's bytes by sha256, checked by the store. */
  read(sha256: string): Promise<Uint8Array>;
  /** Called with the sandbox ID before any work, so the caller journals it. */
  onSandbox(provider: string, id: string): Promise<void>;
  /** Called just before the create request, so a crash mid-create still leaves evidence. */
  onSubmit?(provider: string, attemptId: string): Promise<void>;
  /** Called when the attempt ended after `onSubmit` but before its create was sent. */
  onNotSent?(provider: string, attemptId: string): Promise<void>;
  /**
   * Journals the Compose project's obligation on a daemon (projects.jsonl): awaited before `up`,
   * so a failed write stops the attempt before anything is created.
   */
  onProject?(event: ProjectEvent): Promise<void>;
  /** Receives the cleanup of a create that answers after the attempt returned; the run awaits it. */
  onLateCleanup?(work: Promise<void>): void;
  /** List-price estimate for a sandbox of this provider and track held this long. */
  estimate(durationMs: number): number | null;
  /** Raw step output goes to `<outputDir>/<attemptId>/`. */
  outputDir?: string;
  now?(): number;
  destroyTimeoutMs?: number;
}

export class StageFailure extends Error {
  constructor(
    readonly stage: Stage,
    readonly reason: string,
    readonly detail: string,
  ) {
    super(`${stage}: ${reason}`);
  }
}

function lastOf<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];

    if (item !== undefined && match(item)) return item;
  }

  return undefined;
}

/**
 * Per-step timeouts, sized from the svc-pilot1 and svc-pilot2 runs (2026-11-26, e2b same-machine
 * 4 vCPU / 8 GiB; every step there took 0.1-15.5 s). Each is at least 3x its measured step, with floors because the
 * slow part depends on the guest's own disk and internet, not the provider's API: 60 s for local
 * steps, 120 s for container starts and the test run, 300 s for downloads, and 600 s for the image
 * pull, which on `vfs` storage also copies every layer.
 */
export const stepTimeoutMs = {
  /** The guest probe (measured 0.6-3.2 s). */
  probe: 60_000,
  /** Verify and unpack Node and the fixture (1.6-2.2 s). */
  unpack: 60_000,
  /** Verify and unpack the no-Docker bundle (0.7 s). */
  bundleUnpack: 60_000,
  /** Check nothing answers on the service ports (0.2 s). */
  portsFree: 60_000,
  /** initdb (0.7 s). */
  postgresInit: 60_000,
  /** pg_ctl start, which waits for Postgres itself (0.2 s). */
  postgresStart: 60_000,
  /** redis-server --daemonize and its pid check (0.3 s). */
  redisStart: 60_000,
  /** Docker's static bundle or the rootless extras (5.8 s, about 70 MB). */
  daemonFetch: 300_000,
  /** The Compose plugin (2.0 s). */
  composeFetch: 300_000,
  /** `compose pull` of postgres:16 and redis:7 (7.2-15.5 s on overlayfs). */
  imagePull: 600_000,
  /** `compose up -d` (3.3 s). */
  servicesStart: 120_000,
  /** wait-services.js: Postgres SELECT 1 and Redis PING (0.4-1.0 s); the guest-side wait. */
  servicesReady: 90_000,
  /** npm test, all 9 fixture tests (0.8-0.9 s). */
  tests: 120_000,
} as const;

const tail = (text: string, chars = 1500) => (text.length > chars ? text.slice(-chars) : text);

interface StepOptions {
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Aborts this one call as well as everything on the guest's own signal. */
  signal?: AbortSignal;
}

/**
 * System binary directories, after the image's own PATH. Every guest command runs with them (the
 * probe included), and every launch hands that same PATH through `sudo env`, so the probe and the
 * launch resolve `dockerd`, `docker-proxy` and the rest the same way.
 */
export const systemBin = "/usr/local/sbin:/usr/sbin:/sbin";

/** Runs guest commands, records each as a phase and keeps its raw output. */
/** The sandbox methods the attempt uses; a `Sandbox` is one, and tests script one. */
export interface GuestBox extends UploadBox {
  start(command: string, options: StartOptions): Promise<{ readonly name: string }>;
}

export class Guest {
  dockerHost: string | null = null;
  readonly logs = new Map<string, string>();
  /** Wait between daemon polls. */
  pollMs = 1000;
  /** Monotonic milliseconds for deadlines; `now` stamps the phases. */
  mono: () => number = () => performance.now();

  constructor(
    readonly box: GuestBox,
    readonly signal: AbortSignal,
    readonly phases: Phase[],
    readonly now: () => number,
    /**
     * This attempt's own directory for the Docker and Compose binaries it fetches and verifies.
     * A fresh random name, so nothing the image left at a fixed path is ever run in their place.
     */
    readonly tools = `${guest.root}/tools-${randomBytes(6).toString("hex")}`,
  ) {}

  prelude() {
    const parts = [
      `export PATH=${guest.root}/node/bin:${this.tools}/bin:${this.tools}/docker:${this.tools}/docker-rootless-extras:"$PATH":${systemBin}`,
    ];

    // One endpoint for every docker and compose call: never a configured context's.
    parts.push("unset DOCKER_CONTEXT");

    if (this.dockerHost) parts.push(`export DOCKER_HOST=${quote(`unix://${this.dockerHost}`)}`);

    return `${parts.join("; ")}; `;
  }

  /** Run without recording a phase (polls, diagnostics). */
  exec(command: string, options: StepOptions): Promise<RunResult> {
    const runOptions: RunOptions = {
      cwd: options.cwd ?? "/",
      timeoutMs: options.timeoutMs,
      signal: options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal,
      maxOutputBytes: 256 * 1024,
    };

    if (options.env) runOptions.env = options.env;

    return Promise.resolve(this.box.run(this.prelude() + command, runOptions));
  }

  private keep(name: string, text: string) {
    let key = name;

    for (let i = 2; this.logs.has(key); i++) key = `${name}-${i}`;
    this.logs.set(key, text);
  }

  async step(name: string, command: string, options: StepOptions) {
    const startedAt = this.now();
    const result = await this.exec(command, options);
    this.phases.push({
      name,
      startedAt,
      endedAt: this.now(),
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    this.keep(name, `$ ${command}\n${result.output}`);

    return result;
  }

  /** A step that must pass, or the attempt stops at `stage`. */
  async must(stage: Stage, name: string, command: string, options: StepOptions) {
    const result = await this.step(name, command, options);

    if (!result.ok)
      throw new StageFailure(
        this.signal.aborted ? "timeout" : stage,
        result.timedOut ? `${name} timed out` : `${name} exited ${result.exitCode}`,
        tail(result.output),
      );

    return result;
  }

  /** A timed span around harness work (uploads), recorded as one phase. */
  async span<T>(name: string, work: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    let ok = false;

    try {
      const value = await work();
      ok = true;

      return value;
    } finally {
      this.phases.push({
        name,
        startedAt,
        endedAt: this.now(),
        ok,
        exitCode: null,
        timedOut: false,
      });
    }
  }

  diagnostics(name: string, text: string) {
    this.keep(name, text);
  }
}

const hashCommand =
  'h() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d" " -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d" " -f1; else openssl dgst -sha256 -r "$1" | cut -d" " -f1; fi; }';

const verify = (file: string, sha: string) =>
  `${hashCommand}; got=$(h ${quote(file)}); [ "$got" = ${quote(sha)} ] || { echo "sha256 $got, expected ${sha}"; exit 3; }`;

async function upload(g: Guest, entry: SlotProvider, data: Uint8Array, dest: string) {
  const result = await uploadArtifact({
    box: g.box,
    data,
    dest,
    settings: { concurrency: entry.uploadConcurrency ?? 4 },
    signal: g.signal,
  });

  if (result.exitCode !== 0)
    throw new StageFailure(
      "upload",
      `joining ${dest} exited ${result.exitCode}`,
      tail(result.output),
    );
}

/** Upload and unpack Node and the fixture; the same on both paths. */
async function prepareBase(g: Guest, plan: ServicesPlan, env: ServicesEnvironment) {
  const { node, fixture } = plan.artifacts;

  const [nodeBytes, fixtureBytes] = await Promise.all([
    env.read(node.sha256),
    env.read(fixture.sha256),
  ]);

  await g.span("upload", async () => {
    await g.box.files.write(`${guest.root}/fetch.mjs`, fetchScript);
    await g.box.files.write(`${guest.root}/daemon-ping.mjs`, pingScript);
    await g.box.files.write(`${guest.root}/ports-free.mjs`, portsScript);
    await upload(g, plan.entry, nodeBytes, `${guest.root}/node.tar.gz`);
    await upload(g, plan.entry, fixtureBytes, `/workspace/svc/fixture.tar.gz`);
  });

  await g.must(
    "toolchain",
    "unpack",
    [
      verify(`${guest.root}/node.tar.gz`, node.sha256),
      verify("/workspace/svc/fixture.tar.gz", fixture.sha256),
      `mkdir -p ${guest.root}/node ${guest.app}`,
      `tar -xzf ${guest.root}/node.tar.gz -C ${guest.root}/node --strip-components=1`,
      `tar -xzf /workspace/svc/fixture.tar.gz -C ${guest.app}`,
      `rm -f ${guest.root}/node.tar.gz /workspace/svc/fixture.tar.gz`,
      "node --version",
    ].join(" && "),
    { timeoutMs: stepTimeoutMs.unpack },
  );
}

/** Refuse to start services when anything already answers on their ports. */
async function portsFree(g: Guest, ports: { postgres: number; redis: number }) {
  await g.must(
    "services-start",
    "ports-free",
    `node ${guest.root}/ports-free.mjs ${ports.postgres} ${ports.redis}`,
    { timeoutMs: stepTimeoutMs.portsFree },
  );
}

const pgUrl = (port: number) => `postgres://app:app@127.0.0.1:${port}/postgres`;
const redisUrl = (port: number) => `redis://127.0.0.1:${port}`;

async function waitAndTest(g: Guest, ports: { postgres: number; redis: number }): Promise<Outcome> {
  const env = { DATABASE_URL: pgUrl(ports.postgres), REDIS_URL: redisUrl(ports.redis) };

  // The guest-side wait gives up first, so its own message says which service never answered.
  await g.must(
    "services-ready",
    "services-ready",
    `node scripts/wait-services.js ${stepTimeoutMs.servicesReady}`,
    { cwd: guest.app, env, timeoutMs: stepTimeoutMs.servicesReady + 20_000 },
  );

  const tests = await g.step("tests", "npm test", {
    cwd: guest.app,
    env,
    timeoutMs: stepTimeoutMs.tests,
  });

  const passed = Number(/ℹ pass (\d+)/.exec(tests.output)?.[1] ?? Number.NaN);
  const failed = Number(/ℹ fail (\d+)/.exec(tests.output)?.[1] ?? Number.NaN);

  if (tests.ok && passed === expectedTests && failed === 0)
    return { kind: "green", testsPassed: expectedTests };

  // Recorded as failed even when the exit was 0: a green run passes every test the fixture has.
  const phase = g.phases.at(-1);

  if (phase) phase.ok = false;

  throw new StageFailure(
    g.signal.aborted ? "timeout" : "tests",
    tests.timedOut ? "tests timed out" : `pass ${passed}, fail ${failed}, exit ${tests.exitCode}`,
    tail(tests.output),
  );
}

// ---------------------------------------------------------------- native path

async function nativePath(g: Guest, plan: ServicesPlan, env: ServicesEnvironment, probe: Probe) {
  const ports = plan.ports ?? servicePorts;
  const bundle = plan.artifacts.native;
  const data = await env.read(bundle.sha256);
  const native = `${guest.root}/native`;
  const pg = `${guest.root}/pg`;
  const root = probe.uid === "0";

  await g.span("bundle-upload", () => upload(g, plan.entry, data, `${guest.root}/native.tar.gz`));
  await g.must(
    "upload",
    "bundle-unpack",
    [
      verify(`${guest.root}/native.tar.gz`, bundle.sha256),
      `mkdir -p ${native}`,
      `tar -xzf ${guest.root}/native.tar.gz -C ${native}`,
      `rm -f ${guest.root}/native.tar.gz`,
      `chmod -R a+rX ${native}`,
      `chmod 755 ${guest.root}`,
    ].join(" && "),
    { timeoutMs: stepTimeoutMs.bundleUnpack },
  );

  // Postgres refuses to run as root, so a root sandbox runs it as nobody (65534).
  if (root && probe.setpriv !== "yes")
    throw new StageFailure(
      "services-start",
      "root without setpriv",
      "Postgres refuses to run as root and the image has no setpriv to drop to uid 65534",
    );
  const as = root ? "setpriv --reuid=65534 --regid=65534 --clear-groups -- " : "";
  await portsFree(g, ports);
  const detach = "if command -v setsid >/dev/null 2>&1; then S='setsid -w'; else S=''; fi; ";

  await g.must(
    "services-start",
    "postgres-init",
    [
      `mkdir -p ${pg}`,
      `printf app > ${pg}/pw`,
      root ? `chown -R 65534:65534 ${pg}` : "true",
      `cd ${pg}`,
      `${as}${native}/pg/bin/initdb -D ${pg}/data -U app --pwfile=${pg}/pw --auth-local=trust --auth-host=scram-sha-256 -E UTF8 --locale=C`,
    ].join(" && "),
    { timeoutMs: stepTimeoutMs.postgresInit },
  );
  await g.must(
    "services-start",
    "postgres-start",
    `${detach}cd ${pg} && $S ${as}${native}/pg/bin/pg_ctl -D ${pg}/data -l ${pg}/postgres.log -o ${quote(`-p ${ports.postgres} -k ${pg} -c listen_addresses=127.0.0.1`)} -w -t ${(stepTimeoutMs.postgresStart - 15_000) / 1000} start`,
    { timeoutMs: stepTimeoutMs.postgresStart },
  );
  await g.must(
    "services-start",
    "redis-start",
    `mkdir -p ${guest.root}/redis && ${native}/redis/redis-server --port ${ports.redis} --bind 127.0.0.1 --save '' --appendonly no --daemonize yes --dir ${guest.root}/redis --logfile ${guest.root}/redis/redis.log --pidfile ${guest.root}/redis/redis.pid && i=0; while [ $i -lt 100 ]; do if [ -s ${guest.root}/redis/redis.pid ] && kill -0 "$(cat ${guest.root}/redis/redis.pid)" 2>/dev/null; then exit 0; fi; i=$((i + 1)); sleep 0.1; done; echo "redis-server is not running"; tail -n 20 ${guest.root}/redis/redis.log; exit 1`,
    { timeoutMs: stepTimeoutMs.redisStart },
  );

  return waitAndTest(g, ports);
}

async function nativeDiagnostics(g: Guest) {
  const result = await g
    .exec(
      `tail -n 40 ${guest.root}/pg/postgres.log 2>&1; echo ---; tail -n 40 ${guest.root}/redis/redis.log 2>&1`,
      { timeoutMs: 30_000 },
    )
    .catch(() => ({ output: "diagnostics command failed" }));

  g.diagnostics("native-diagnostics", result.output);
}

// ---------------------------------------------------------------- compose path

interface LadderInput {
  readonly method: DaemonMethod;
  readonly configs: readonly DaemonConfig[];
  /** The daemon command for one config, with every path it writes inside `dir`. */
  readonly command: (config: DaemonConfig, dir: string) => string;
  /** The socket that daemon serves, inside its own directory. */
  readonly socket: (dir: string) => string;
  readonly asRoot: boolean;
  /**
   * The daemon shares the guest's network namespace (rootful dockerd: `docker0` and firewall
   * rules), so no two may run at once: each launch needs the one before it confirmed stopped.
   */
  readonly sharedNetwork: boolean;
}

interface DaemonConfig {
  readonly id: string;
  readonly flags: string;
  readonly network: "bridge" | "host";
}

/** Rootful dockerd, most capable first: a config only runs when the one before it failed. */
const rootfulConfigs: readonly DaemonConfig[] = [
  { id: "default", flags: "", network: "bridge" },
  { id: "no-iptables", flags: "--iptables=false --ip6tables=false", network: "bridge" },
  // The vfs configs also serve a daemon that answers but cannot mount overlay layers (overlay on
  // overlay inside a container): see Daemon.switchStorage.
  { id: "vfs", flags: "--storage-driver=vfs", network: "bridge" },
  {
    id: "no-iptables-vfs",
    flags: "--iptables=false --ip6tables=false --storage-driver=vfs",
    network: "bridge",
  },
  {
    id: "no-bridge-vfs",
    flags: "--iptables=false --ip6tables=false --bridge=none --storage-driver=vfs",
    network: "host",
  },
];

const rootlessConfigs: readonly DaemonConfig[] = [
  { id: "default", flags: "", network: "bridge" },
  { id: "vfs", flags: "--storage-driver=vfs", network: "bridge" },
];

/** daemon-ping.mjs's success line. */
const pingSchema = z.object({
  ok: z.literal(true),
  serverVersion: z.string().nullable().catch(null),
  storageDriver: z.string().nullable().catch(null),
});

type Ping = z.infer<typeof pingSchema>;

function pingResult(output: string): Ping | null {
  const line = output.split("\n").find((l) => l.startsWith("{")) ?? "";

  try {
    const parsed = pingSchema.safeParse(JSON.parse(line));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Daemon and storage errors that refuse one named prerequisite. Only these make a failed try
 * conclusive; any other error (no space left, a crash, a timeout, a log that merely mentions a
 * subsystem) says nothing about whether Docker can run here.
 */
export const prerequisiteRefusals: readonly {
  readonly prerequisite: string;
  readonly pattern: RegExp;
}[] = [
  {
    prerequisite: "root privileges",
    pattern: /dockerd needs to be started with root privileges|must be run as root/i,
  },
  {
    prerequisite: "iptables",
    pattern:
      /iptables[^\n]*(?:executable file not found|not found in \$PATH|permission denied \(you must be root\)|can't initialize iptables table)/i,
  },
  {
    prerequisite: "an overlay mount",
    pattern:
      /overlay[^\n]*mount[^\n]*: (?:invalid argument|operation not permitted|no such device)|mount[^\n]*overlay[^\n]*: (?:invalid argument|operation not permitted|no such device)|driver not supported: overlay/i,
  },
  {
    prerequisite: "a writable cgroup",
    pattern:
      /cgroup[^\n]*: (?:read-only file system|operation not permitted|permission denied)|cannot find cgroup mount destination/i,
  },
  {
    prerequisite: "user namespaces",
    pattern:
      /(?:unshare|clone)[^\n]*: (?:operation not permitted|invalid argument)|newuidmap[^\n]*(?:operation not permitted|not found)|user namespaces? (?:are |is )?not (?:enabled|permitted|supported)/i,
  },
];

/** The prerequisite `text` refuses, or null when it refuses none. */
export function refusedPrerequisite(text: string): string | null {
  return prerequisiteRefusals.find((r) => r.pattern.test(text))?.prerequisite ?? null;
}

/** A ping refused this way found no daemon serving that socket: a fact, not a fault. */
const noDaemonOnSocket = /ENOENT|ECONNREFUSED/;

/**
 * Stop the process tree a launch in `dir` recorded, and nothing else: only when the recorded PID
 * is still that launch (its command line names `dir`, so a reused PID is left alone), TERM to its
 * root, then KILL to whatever of the tree, read before the TERM, is still there. Each process is
 * known by its PID and start time, and KILL goes only to one whose start time still matches.
 * Prints STOPPED once none of that tree is alive (or the launch was already gone), SURVIVED when
 * some of it still is, and NOPID when the launch never recorded its PID: only STOPPED confirms.
 */
export const stopTree = (dir: string) =>
  `p=$(cat ${dir}/launch.pid 2>/dev/null); [ -n "$p" ] || { echo NOPID; exit 0; }; tr '\\0' ' ' < /proc/"$p"/cmdline 2>/dev/null | grep -qF -- ${quote(dir)} || { echo STOPPED; exit 0; }; st() { sed 's/.*) //' /proc/"$1"/stat 2>/dev/null | cut -d' ' -f20; }; up() { s=$(sed 's/.*) //' /proc/"$1"/stat 2>/dev/null | cut -d' ' -f1,20); [ -n "$2" ] && [ "\${s#* }" = "$2" ] && [ "\${s%% *}" != Z ] && [ "\${s%% *}" != X ]; }; t() { echo "$1:$(st "$1")"; for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do t "$c"; done; }; all=$(t "$p"); kill -TERM "$p" 2>/dev/null; i=0; while [ $i -lt 20 ] && [ -d /proc/"$p" ]; do sleep 0.5; i=$((i + 1)); done; for e in $all; do up "\${e%%:*}" "\${e#*:}" && kill -KILL "\${e%%:*}" 2>/dev/null; done; j=0; while :; do left=; for e in $all; do up "\${e%%:*}" "\${e#*:}" && left=1; done; [ -z "$left" ] && { echo STOPPED; exit 0; }; [ $j -ge 10 ] && { echo SURVIVED; exit 0; }; sleep 0.2; j=$((j + 1)); done`;

/**
 * Lists every dockerd or containerd alive, one `pid:name` per line, and any PID still there whose
 * name, or a daemon's state, could not be read (`UNREADABLE:pid`), then `SCANNED <count>`
 * exactly. A zombie or dead daemon (state Z or X) is gone, as stopTree counts it; processes that
 * exit during the scan are skipped.
 */
export const daemonScan = `n=0; for p in /proc/[0-9]*; do [ -d "$p" ] || continue; if ! c=$(cat "$p"/comm 2>/dev/null); then [ -d "$p" ] && echo "UNREADABLE:\${p#/proc/}"; continue; fi; n=$((n + 1)); case "$c" in dockerd|containerd) s=$(sed 's/.*) //' "$p"/stat 2>/dev/null | cut -d' ' -f1); case "$s" in Z|X) ;; '') [ -d "$p" ] && echo "UNREADABLE:\${p#/proc/}" ;; *) echo "\${p#/proc/}:$c" ;; esac ;; esac; done; echo "SCANNED $n"`;

/**
 * Which process in this guest serves the listening socket at `$1`, at the privilege it runs with:
 * `OWNER <pid> <comm>` for a dockerd or podman holding the socket's inode, and exit 0; else, with
 * exit 3, `NOT-LISTENING` (nothing in this network namespace listens there: a socket mounted in
 * from outside), `AMBIGUOUS <n>` (more than one listener carries that path, so which one a client
 * reaches is unknown) or `NO-OWNER <inode>` (no dockerd or podman here that can be read holds it).
 */
export const socketOwner = `s="$1"; r=$(readlink -f "$s" 2>/dev/null || echo "$s"); found=$(awk -v a="$s" -v b="$r" '$4 == "00010000" && ($NF == a || $NF == b) && !seen[$7]++ { n++; i = $7 } END { print n + 0, i }' /proc/net/unix) || exit 4; ino=\${found#* }; case "\${found%% *}" in 0) echo NOT-LISTENING; exit 3 ;; 1) ;; *) echo "AMBIGUOUS \${found%% *}"; exit 3 ;; esac; for p in /proc/[0-9]*; do c=$(cat "$p"/comm 2>/dev/null) || continue; case "$c" in dockerd|podman) for f in "$p"/fd/*; do [ "$(readlink "$f" 2>/dev/null)" = "socket:[$ino]" ] && { echo "OWNER \${p#/proc/} $c"; exit 0; }; done ;; esac; done; echo "NO-OWNER $ino"; exit 3`;

/** One method of the ladder: tries it, or records the probe fact that rules it out. */
/** The attempt a Compose project belongs to, as its journal names it. */
interface ProjectOwner {
  readonly provider: string;
  readonly attemptId: string;
  readonly sandboxId: string | null;
}

interface Rung {
  readonly method: DaemonMethod;
  readonly run: () => Promise<boolean>;
}

/** A Compose project name no other attempt uses: lowercase letters, digits and dashes. */
export const composeProject = (attemptId: string) =>
  `sbx-${attemptId.toLowerCase().replaceAll(/[^a-z0-9-]/g, "-")}-${randomBytes(3).toString("hex")}`;

class Daemon {
  readonly record: DaemonRecord;
  /** The compose command once one works: `docker compose` or the fetched plugin binary's path. */
  compose = "";
  /** Every method in ladder order (getDaemon). */
  rungs: readonly Rung[] = [];
  /** The attempt's project was brought up on the chosen daemon, so it must come down there. */
  projectUsed = false;
  /** Journals project claims (ServicesEnvironment.onProject); set by composePath. */
  onProject: ((event: ProjectEvent) => Promise<void>) | null = null;
  /** Whose project this is, for the journal; set by composePath. */
  owner: ProjectOwner = { provider: "", attemptId: "", sandboxId: null };
  /** Claims journaled as pending and not yet resolved. */
  private claims: ProjectEvent[] = [];
  /** The ladder and config index that answered, so a storage failure can continue past it. */
  private resume: { input: LadderInput; index: number } | null = null;
  /** The rung whose daemon is in use, so a storage failure can go on to the methods after it. */
  private rung = -1;
  /** The daemon this attempt launched and is using: the only process it ever stops. */
  private launched: {
    readonly dir: string;
    readonly asRoot: boolean;
    readonly sharedNetwork: boolean;
  } | null = null;
  /** What this attempt fetched and verified into its own tool directory. */
  private readonly fetched = { static: false, rootless: false };
  /** The daemon's socket needs root: every docker and compose call goes through sudo. */
  private viaSudo = false;
  private socket = "/var/run/docker.sock";

  constructor(
    readonly g: Guest,
    readonly probe: Probe,
    readonly readyMs: number,
    readonly project: string,
  ) {
    this.record = {
      method: null,
      config: null,
      skipped: [],
      tries: [],
      storageDriver: null,
      network: null,
      serverVersion: null,
      compose: null,
      project,
      launched: false,
      down: null,
      answered: null,
      finished: false,
    };
  }

  private get sudo() {
    return this.probe.uid === "0" ? "" : "sudo -n ";
  }

  /**
   * Prefix for docker and compose calls. A root-only socket is reached through sudo with the same
   * endpoint and the variables compose.yaml reads; its permissions are never changed.
   */
  get client() {
    return this.viaSudo
      ? 'sudo -n env PATH="$PATH" DOCKER_HOST="$DOCKER_HOST" SBX_PG_PORT="${SBX_PG_PORT:-}" SBX_REDIS_PORT="${SBX_REDIS_PORT:-}" '
      : "";
  }

  get files() {
    return this.record.network === "host"
      ? "-f compose.yaml -f compose.host-network.yaml"
      : "-f compose.yaml";
  }

  /** A compose command on this attempt's project, against the chosen daemon. */
  composeCommand(args: string) {
    return `${this.client}${this.compose} -p ${quote(this.project)} ${this.files} ${args}`;
  }

  skip(method: DaemonMethod, reason: string) {
    this.record.skipped.push({ method, reason });

    return false;
  }

  /** Climb from rung `from`; true once a method's daemon answers. */
  async climb(from: number): Promise<boolean> {
    for (let index = from; index < this.rungs.length; index++) {
      const rung = this.rungs[index];

      if (rung && (await rung.run())) {
        this.rung = index;

        return true;
      }
    }

    return false;
  }

  /** The time left before `deadline` on the monotonic clock, as a command timeout. */
  private left(deadline: number) {
    return Math.max(1, Math.min(20_000, Math.ceil(deadline - this.g.mono())));
  }

  /** Stop a daemon this attempt launched, by the PID its launch recorded; nothing else is signalled. */
  /** True once that launch's whole process tree is confirmed gone (stopTree's STOPPED). */
  private async stop(dir: string, asRoot: boolean): Promise<boolean> {
    const runner = asRoot && this.sudo ? this.sudo : "";

    // On its own bounded timer: a stalled stop never holds the next rung.
    const result = await this.within(this.g.mono() + 30_000, (signal) =>
      this.g.exec(`${runner}sh -c ${quote(stopTree(dir))}`, { timeoutMs: 30_000, signal }),
    ).catch(() => null);

    return result?.value.output.split("\n").includes("STOPPED") ?? false;
  }

  /**
   * `work` with an abort signal of its own, raced against `deadline` on the monotonic clock. Past
   * the deadline the call is aborted and null comes back at once, so a stalled exec can never
   * hold the ladder; a call that settles in time comes back as `{ value }` or rejects.
   */
  private async within<T>(
    deadline: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ value: T } | null> {
    const own = new AbortController();
    const call = work(own.signal);
    call.catch(() => {});

    const outcome = await Promise.race([
      call.then((value) => ({ value })),
      after(Math.max(0, deadline - this.g.mono())).then(() => null),
    ]);

    if (outcome === null) own.abort(new Error("past the daemon deadline"));

    return outcome;
  }

  /** A readiness ping that answers by `deadline`, or null. */
  private async pingBy(asRoot: boolean, deadline: number) {
    return (
      (await this.within(deadline, (signal) => this.ping(asRoot, this.left(deadline), signal)))
        ?.value ?? null
    );
  }

  /**
   * Why no further shared-network (rootful) daemon may start in this guest, once known: another
   * daemon is running beside us, or one of ours was never confirmed stopped. It stays set.
   */
  private sharedBlocked: string | null = null;

  /**
   * Right before each shared-network launch: true when none may be blocking it. The guest is
   * scanned at launch privilege for any dockerd or containerd (ours are all confirmed stopped by
   * then); one there, an unreadable PID or a scan that did not finish exactly blocks every later
   * shared-network launch, recorded once as an inconclusive failed try.
   */
  async mayShareNetwork(method: DaemonMethod): Promise<boolean> {
    const startedAt = this.g.now();

    if (this.sharedBlocked === null) {
      const scan = await this.within(this.g.mono() + 20_000, (signal) =>
        this.g.exec(`${this.sudo}sh -c ${quote(daemonScan)}`, { timeoutMs: 20_000, signal }),
      ).catch(() => null);

      const lines = (scan?.value.output ?? "").split("\n").filter((line) => line.trim());
      const others = lines.filter((line) => /^\d+:/.test(line));
      const unreadable = lines.filter((line) => line.startsWith("UNREADABLE:"));
      const finished = scan?.value.ok === true && /^SCANNED [1-9]\d*$/.test(lines.at(-1) ?? "");

      if (others.length)
        this.sharedBlocked = `another daemon owns the network namespace (${others.join(", ")})`;
      else if (!finished || unreadable.length)
        this.sharedBlocked = `could not check for another daemon in the network namespace${unreadable.length ? ` (${unreadable.join(", ")})` : ""}`;
    }

    if (this.sharedBlocked === null) return true;

    if (!this.record.tries.some((t) => t.config === "ownership" && t.method === method))
      this.record.tries.push({
        method,
        config: "ownership",
        ok: false,
        ms: this.g.now() - startedAt,
        error: this.sharedBlocked,
        conclusive: false,
      });

    return false;
  }

  /**
   * The daemon answered but cannot use its storage driver (Daytona: overlay layers fail to mount
   * inside the sandbox's own overlay). This attempt's project comes down on it first: when that
   * fails, the project is an open cleanup obligation on that daemon, so no other rung runs. Then
   * the try is recorded as failed, a daemon this attempt launched is stopped, and the ladder goes
   * on: the same method's later vfs configs, then every method after it. False when nothing else
   * answers or the project did not come down.
   */
  async switchStorage(reason: string): Promise<boolean> {
    if (!(await this.down(this.g, composeDownMs))) return false;

    const resume = this.resume;
    const last = lastOf(this.record.tries, (t) => t.ok);
    const refused = refusedPrerequisite(reason);

    if (last) {
      last.ok = false;
      last.error = `answered, but ${tail(reason, 300)}${refused ? `; refused: ${refused}` : ""}`;
      last.conclusive = refused !== null;

      const phase = lastOf(
        this.g.phases,
        (p) => p.name === `daemon-start:${last.method}:${last.config}` && p.ok,
      );

      if (phase) {
        phase.ok = false;
        phase.note = "answered, but its storage driver failed";
      }
    }

    if (
      this.launched &&
      !(await this.stop(this.launched.dir, this.launched.asRoot)) &&
      this.launched.sharedNetwork
    )
      this.sharedBlocked = `the ${this.record.method ?? "?"}/${this.record.config ?? "?"} daemon was not confirmed stopped`;
    this.launched = null;
    this.record.method = null;
    this.record.config = null;
    this.record.launched = false;
    this.record.down = null;
    this.projectUsed = false;
    this.resume = null;
    this.viaSudo = false;
    // Unfinished until the fallback picks a config or runs out; an abort in between leaves it so.
    this.record.finished = false;

    const found =
      (resume !== null &&
        (await this.ladder(resume.input, resume.index + 1, (config) =>
          config.flags.includes("--storage-driver=vfs"),
        ))) ||
      (await this.climb(this.rung + 1));

    this.record.finished = true;

    return found;
  }

  /** Readiness only: the helper exits as soon as /_ping answers. */
  private ping(asRoot: boolean, timeoutMs: number, signal: AbortSignal) {
    const runner = asRoot && this.sudo ? `${this.sudo}env PATH="$PATH" ` : "";

    return this.g.exec(`${runner}node ${guest.root}/daemon-ping.mjs ${quote(this.socket)}`, {
      timeoutMs,
      signal,
    });
  }

  private readonly pendingLogs: { attempt: DaemonTry; log: string; name: string }[] = [];

  /**
   * Each started daemon's log into the diagnostics, and a failed try's reason from its log. A try
   * whose log refuses a named prerequisite becomes conclusive. `via` runs the reads: after the
   * verdict, a guest on its own short signal, never the workload's.
   */
  async collectLogs(via: Guest = this.g) {
    for (const { attempt, log, name } of this.pendingLogs.splice(0)) {
      const text = await via
        .exec(`tail -c 6000 ${quote(log)} 2>&1`, { timeoutMs: 20_000 })
        .then((r) => r.output)
        .catch(() => "");

      this.g.diagnostics(name, text);

      if (!attempt.ok && attempt.error && !attempt.error.startsWith("answered")) {
        const reason = text
          .split("\n")
          .filter((line) => /level=(error|fatal)|failed to start|Error|error:/i.test(line))
          .slice(-2)
          .join(" | ");

        if (reason) attempt.error = `${attempt.error}: ${tail(reason, 400)}`;
        const refused = refusedPrerequisite(reason);

        if (refused) {
          attempt.error = `${attempt.error}; refused: ${refused}`;
          attempt.conclusive = true;
        }
      }
    }
  }

  /** The chosen daemon's version and storage driver, and the daemon logs, after the verdict. */
  async readMetadata(via: Guest) {
    await this.collectLogs(via);

    if (!this.record.method) return;
    via.dockerHost = this.g.dockerHost;

    const runner = this.viaSudo ? 'sudo -n env PATH="$PATH" ' : "";

    const result = await via.exec(
      `${runner}node ${guest.root}/daemon-ping.mjs ${quote(this.socket)} --meta`,
      { timeoutMs: 20_000 },
    );

    const ping = pingResult(result.output);

    if (ping) {
      this.record.serverVersion = ping.serverVersion;
      this.record.storageDriver = ping.storageDriver;
    }
  }

  /**
   * `compose down -v` of this attempt's project on the daemon that ran it, tried twice within
   * `timeoutMs`. True once it exits 0, or when the project never came up; false leaves the
   * project as an open cleanup obligation on that daemon (`record.down`).
   */
  /**
   * The project's obligation on the chosen daemon, journaled before `up` can create anything
   * there; a write that fails rejects, and `up` is never sent. With it go the guest commands
   * recovery runs around its `down`: `quiesce` kills every process whose command line names the
   * project (a `compose up` a crashed runner left behind) with its tree and waits for them to exit;
   * `settle` lists the project's labelled containers, volumes and networks twice, 3 s apart, and
   * exits 0 only when both lists are empty. The bracketed first letter keeps pgrep from matching
   * the script's own text, and the script's own ancestors are never signalled.
   */
  async claim() {
    const pattern = quote(`[${this.project.slice(0, 1)}]${this.project.slice(1)}`);
    const kill = this.viaSudo ? "sudo -n kill" : "kill";
    const docker = `${this.client}docker`;

    const event: ProjectEvent = {
      ...this.owner,
      project: this.project,
      daemon: `${this.record.method ?? "?"}/${this.record.config ?? "?"}`,
      provenance: this.record.method === "preinstalled-running" ? "in-sandbox" : "launched",
      state: "pending",
      down: `${this.g.prelude()}${this.composeCommand(composeDown)}`,
      quiesce: [
        `command -v pgrep >/dev/null && command -v ps >/dev/null || { echo "no pgrep or ps"; exit 4; }`,
        `anc=" "; a=$$; while [ -n "$a" ] && [ "$a" -gt 1 ]; do anc="$anc$a "; a=$(ps -o ppid= -p "$a" | tr -d " "); done`,
        `others() { o=$(pgrep -f -- ${pattern}); [ $? -le 1 ] || exit 4; left=""; for p in $o; do case "$anc" in *" $p "*) ;; *) left="$left $p" ;; esac; done; }`,
        `walk() { for c in $(pgrep -P "$1"); do walk "$c"; done; echo "$1"; }`,
        `others; for p in $left; do ${kill} -KILL $(walk "$p") 2>/dev/null; done`,
        `n=0; while others; [ -n "$left" ]; do n=$((n + 1)); [ $n -lt 20 ] || { echo "still running:$left"; exit 3; }; sleep 0.5; done`,
      ].join("; "),
      settle: `${this.g.prelude()}${[
        `f=${quote(`label=com.docker.compose.project=${this.project}`)}`,
        `left() { c=$(${docker} ps -aq --filter "$f") && v=$(${docker} volume ls -q --filter "$f") && n=$(${docker} network ls -q --filter "$f") || { echo "listing failed"; exit 4; }; [ -z "$c$v$n" ] || { echo "left: $c $v $n"; exit 3; }; }`,
        "left; sleep 3; left",
      ].join("; ")}`,
    };

    await this.onProject?.(event);
    this.claims.push(event);
    this.projectUsed = true;
  }

  /** Resolve the claims on daemons inside a sandbox whose deletion is now confirmed. */
  async releaseWithSandbox() {
    for (const claim of this.claims.filter((c) => c.provenance !== "as-found"))
      await this.onProject?.({ ...claim, state: "with-sandbox" }).catch(() => {});
    this.claims = this.claims.filter((c) => c.provenance === "as-found");
  }

  async down(via: Guest, timeoutMs: number): Promise<boolean> {
    if (!this.projectUsed || !this.record.method || !this.compose) return true;
    via.dockerHost = this.g.dockerHost;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await via
        .exec(this.composeCommand(composeDown), {
          cwd: guest.app,
          timeoutMs: Math.floor(timeoutMs / 2),
        })
        .catch((error: Error) => ({ ok: false, output: error.message }));

      this.g.diagnostics("compose-down", result.output);

      if (result.ok) {
        this.record.down = true;
        const daemon = `${this.record.method}/${this.record.config ?? "?"}`;

        // A clearing line that fails to write leaves the claim pending: the safe side.
        for (const claim of this.claims.filter((c) => c.daemon === daemon))
          await this.onProject?.({ ...claim, state: "down" }).catch(() => {});
        this.claims = this.claims.filter((c) => c.daemon !== daemon);

        return true;
      }
    }

    this.record.down = false;

    return false;
  }

  private succeed(method: DaemonMethod, config: DaemonConfig, ping: Ping | null, root: boolean) {
    this.record.answered ??= `${method}/${config.id}`;
    this.record.method = method;
    this.record.config = config.id;
    this.record.network = config.network;
    this.record.serverVersion = ping?.serverVersion ?? null;
    this.record.storageDriver = ping?.storageDriver ?? null;
    this.record.launched = method !== "preinstalled-running";
    this.viaSudo = root && this.sudo !== "";
  }

  /**
   * A daemon already answering on the default socket, within `readyMs` on the monotonic clock;
   * an answer after that is refused. Anything that does not answer in time is left alone and
   * the rung is unavailable. One that answers is used only when its dockerd or podman holds the
   * socket in this guest (`socketOwner`); otherwise it is ruled out (`outsideSandbox`) and the
   * ladder goes on to this attempt's own launches.
   */
  async running(): Promise<boolean> {
    this.socket = "/var/run/docker.sock";
    this.g.dockerHost = this.socket;
    const startedAt = this.g.now();
    const deadline = this.g.mono() + this.readyMs;
    // Checked on the socket itself, whatever DOCKER_HOST or a saved context told the probe's
    // `docker info`: as the sandbox user, then through sudo for a root-only socket.
    let asRoot = false;
    let result = await this.pingBy(false, deadline);

    if (
      result !== null &&
      !result.ok &&
      this.probe.sudo === "passwordless" &&
      this.g.mono() < deadline
    ) {
      asRoot = true;
      result = await this.pingBy(true, deadline);
    }

    const late = result?.ok === true && this.g.mono() > deadline;
    const answered = result?.ok === true && !late;
    const answeredAt = this.g.now();

    // Only a daemon living in this guest goes with the sandbox, so only one is used: its dockerd or
    // podman must hold the socket here, shown within the same budget. One outside, or one not shown
    // to be inside, could keep a project after the sandbox is gone; it is never used, and since that
    // says nothing about Docker inside the guest, the try is inconclusive.
    const owner = answered
      ? await this.within(deadline, (signal) =>
          this.g.exec(
            `${canBeRoot(this.probe) ? this.sudo : ""}sh -c ${quote(socketOwner)} sh ${this.socket}`,
            { timeoutMs: this.left(deadline), signal },
          ),
        ).catch(() => null)
      : null;

    if (answered)
      this.g.diagnostics("socket-owner", owner?.value.output ?? "no answer within the budget");

    const refused = !answered
      ? null
      : owner?.value.ok === true && /^OWNER \d+ (?:dockerd|podman)$/m.test(owner.value.output)
        ? null
        : owner?.value.exitCode === 3 && owner.value.output.trim() === "NOT-LISTENING"
          ? outsideSandbox
          : ownershipUnverified;

    const ok = answered && refused === null;
    this.record.tries.push({
      method: "preinstalled-running",
      config: "as-found",
      ok,
      ms: answeredAt - startedAt,
      error: ok
        ? null
        : (refused ??
          (result === null
            ? `no answer within ${this.readyMs} ms`
            : late
              ? `answered only after ${this.readyMs} ms`
              : tail(result.output, 300))),
      conclusive: result !== null && !result.ok && noDaemonOnSocket.test(result.output),
    });
    // The start is the ping's answer, recorded as one only once the daemon is shown to be ours.
    this.g.phases.push({
      name: "daemon-start:preinstalled-running:as-found",
      startedAt,
      endedAt: answeredAt,
      ok,
      exitCode: result?.exitCode ?? null,
      timedOut: result === null || result.timedOut,
    });

    if (!ok || result === null) {
      this.g.dockerHost = null;

      return refused === null ? false : this.skip("preinstalled-running", refused);
    }

    this.succeed(
      "preinstalled-running",
      { id: "as-found", flags: "", network: "bridge" },
      pingResult(result.output),
      asRoot,
    );

    return true;
  }

  /**
   * Launch a daemon with each config in turn until one answers /_ping within `readyMs`, counted
   * on the monotonic clock from just before the launch: the launch call, every poll and every
   * liveness check share that budget, and an answer after it is refused. Each config gets its own
   * directory under the attempt's tool directory for its socket, PID, exec root and log, and a
   * config that fails is stopped by the PID its launch recorded.
   */
  async ladder(
    input: LadderInput,
    from = 0,
    only: (config: DaemonConfig) => boolean = () => true,
  ): Promise<boolean> {
    for (const [index, config] of input.configs.entries()) {
      if (index < from || !only(config)) continue;

      // An abort ends the ladder as a timeout: it says nothing about whether Docker works here.
      if (this.g.signal.aborted)
        throw new StageFailure(
          "timeout",
          "attempt timeout",
          "Stopped before starting another daemon",
        );

      // Never beside another shared-network daemon: checked again right before each launch.
      if (input.sharedNetwork && !(await this.mayShareNetwork(input.method))) break;
      const dir = `${this.g.tools}/${input.method}-${config.id}`;
      const log = `${dir}/daemon.log`;
      this.socket = input.socket(dir);
      this.g.dockerHost = this.socket;
      const startedAt = this.g.now();
      let error: string | null = null;
      let ping: Ping | null = null;
      // When /_ping first answered: the phase ends there, not after the log read below.
      let readyAt: number | null = null;

      try {
        this.g.signal.throwIfAborted();
        const deadline = this.g.mono() + this.readyMs;

        const start = this.g.box.start(
          `${this.g.prelude()}mkdir -p -m 700 ${dir} && printf '{}' > ${dir}/daemon.json && echo $$ > ${dir}/launch.pid && exec ${input.command(config, dir)} >${log} 2>&1`,
          { name: `sbx-${input.method}-${config.id}` },
        );

        const launched = await Promise.race([
          start.then(() => true),
          after(Math.max(0, deadline - this.g.mono())).then(() => false),
        ]);

        // A launch that returns late is stopped by its own PID once it does.
        if (!launched) {
          void start.then(() => this.stop(dir, input.asRoot)).catch(() => {});
          error = `launch did not return within ${this.readyMs} ms`;

          // It may be running already: no other shared-network daemon starts beside it.
          if (input.sharedNetwork)
            this.sharedBlocked = `the ${input.method}/${config.id} launch did not return`;
        }

        for (; launched;) {
          this.g.signal.throwIfAborted();

          if (this.g.mono() >= deadline) {
            error = `no answer within ${this.readyMs} ms`;
            break;
          }

          const result = await this.pingBy(input.asRoot, deadline);

          if (result === null) {
            error = `no answer within ${this.readyMs} ms`;
            break;
          }

          if (result.ok) {
            // An answer that arrives past the deadline does not count.
            if (this.g.mono() > deadline) {
              error = `no answer within ${this.readyMs} ms`;
              break;
            }

            readyAt = this.g.now();
            ping = pingResult(result.output);
            break;
          }

          // A daemon that already exited will never answer; give it a few seconds to appear first.
          if (this.g.mono() < deadline) {
            const alive = await this.within(deadline, (signal) =>
              this.g.exec(
                `p=$(cat ${dir}/launch.pid 2>/dev/null); [ -n "$p" ] && [ -d /proc/"$p" ] || echo DEAD`,
                { timeoutMs: this.left(deadline), signal },
              ),
            );

            if (alive?.value.output.includes("DEAD")) {
              error = "daemon exited";
              break;
            }
          }

          const wait = Math.min(this.g.pollMs, deadline - this.g.mono());

          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        }
      } catch (cause) {
        // The sandbox itself is gone: a provider failure, never a Docker result.
        // An observed abort comes first: what the provider says after it is not a verdict.
        if (this.g.signal.aborted)
          throw new StageFailure("timeout", "attempt timeout", "Aborted while a daemon started");

        if (cause instanceof SandboxError && cause.code === "not_found")
          throw new StageFailure("error", "sandbox disappeared", cause.message);
        error = cause instanceof Error ? cause.message : String(cause);
      }

      // An abort the poll loop noticed only as a timed-out command is still an abort.
      if (readyAt === null && this.g.signal.aborted)
        throw new StageFailure("timeout", "attempt timeout", "Aborted while waiting for a daemon");
      const endedAt = readyAt ?? this.g.now();
      const ok = error === null;

      const attempt: DaemonTry = {
        method: input.method,
        config: config.id,
        ok,
        ms: endedAt - startedAt,
        error,
        // Conclusive only once its log refuses a named prerequisite (collectLogs).
        conclusive: false,
      };

      this.record.tries.push(attempt);
      // The daemon's log is read later (collectLogs), outside every timed phase.
      this.pendingLogs.push({ attempt, log, name: `daemon-${input.method}-${config.id}` });
      this.g.phases.push({
        name: `daemon-start:${input.method}:${config.id}`,
        startedAt,
        endedAt,
        ok,
        exitCode: null,
        timedOut: false,
      });

      if (ok) {
        this.succeed(input.method, config, ping, input.asRoot);
        this.launched = { dir, asRoot: input.asRoot, sharedNetwork: input.sharedNetwork };
        this.resume = { input, index };

        return true;
      }

      if (!(await this.stop(dir, input.asRoot)) && input.sharedNetwork)
        this.sharedBlocked ??= `the ${input.method}/${config.id} daemon was not confirmed stopped`;
    }

    this.g.dockerHost = null;

    return false;
  }

  /**
   * Docker's static bundle (and the rootless extras when asked), fetched by hash into this
   * attempt's own tool directory. Only binaries this attempt fetched and verified are ever run.
   */
  async fetchStatic(rootless: boolean) {
    const tools = this.g.tools;

    const fetch = (pin: { url: string; sha256: string }, file: string) =>
      `node ${guest.root}/fetch.mjs ${quote(pin.url)} ${pin.sha256} ${tools}/${file} && tar -xzf ${tools}/${file} -C ${tools} && rm -f ${tools}/${file}`;

    const commands = [`mkdir -p -m 700 ${tools}`];

    if (!this.fetched.static) commands.push(fetch(dockerStatic, "docker.tgz"));

    if (rootless && !this.fetched.rootless)
      commands.push(fetch(dockerRootlessExtras, "rootless.tgz"));
    const method = rootless ? "rootless" : "static-rootful";

    const name = `daemon-fetch:${rootless ? "rootless" : "static"}`;
    const startedAt = this.g.now();
    let error: string | null = null;

    try {
      const result = await this.g.step(name, commands.join(" && "), {
        timeoutMs: stepTimeoutMs.daemonFetch,
      });

      if (!result.ok) error = `download failed: ${tail(result.output, 300)}`;
    } catch (cause) {
      // A provider error on the exec itself: recorded as this rung's failure like a bad download.
      error = `download command failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      this.g.phases.push({
        name,
        startedAt,
        endedAt: this.g.now(),
        ok: false,
        exitCode: null,
        timedOut: false,
      });
    }

    if (this.g.signal.aborted)
      throw new StageFailure("timeout", "daemon fetch timed out", error ?? "");

    // A failed download is a failed rung, and says nothing about Docker: the ladder goes on.
    if (error !== null) {
      this.record.tries.push({
        method,
        config: "fetch",
        ok: false,
        ms: this.g.now() - startedAt,
        error,
        conclusive: false,
      });

      return false;
    }

    this.fetched.static = true;

    if (rootless) this.fetched.rootless = true;

    return true;
  }

  async ensureCompose() {
    const found = await this.g
      .exec(`${this.client}docker compose version --short`, { timeoutMs: 30_000 })
      .catch(() => null);

    if (found?.ok && /^v?[2-9]\./.test(found.output.trim())) {
      this.compose = "docker compose";
      this.record.compose = "preinstalled";

      return;
    }

    const tools = this.g.tools;
    const plugin = `${tools}/bin/docker-compose`;

    await this.g.must(
      "daemon",
      "compose-fetch",
      `mkdir -p -m 700 ${tools} && mkdir -p ${tools}/bin && node ${guest.root}/fetch.mjs ${quote(composePlugin.url)} ${composePlugin.sha256} ${plugin} && chmod +x ${plugin} && ${plugin} version --short`,
      { timeoutMs: stepTimeoutMs.composeFetch },
    );
    this.compose = plugin;
    this.record.compose = "fetched";
  }
}

export async function getDaemon(
  g: Guest,
  probe: Probe,
  readyMs: number,
  keep: (daemon: Daemon) => void,
  project = composeProject("attempt"),
): Promise<Daemon> {
  const d = new Daemon(g, probe, readyMs, project);
  keep(d);
  const sudo = probe.uid === "0" ? "" : "sudo -n ";
  // Storage of a rootful daemon stays on the root disk, in a directory only this attempt uses, and
  // its containers in containerd namespaces of its own, so a system containerd it finds and joins
  // never shares state with another daemon.
  const tag = g.tools.split("/").at(-1) ?? "attempt";
  const dataRoot = `/var/lib/sbx-docker/${tag}`;

  const rootful = (method: DaemonMethod, dockerd: string) =>
    d.ladder({
      method,
      configs: rootfulConfigs,
      socket: (dir) => `${dir}/docker.sock`,
      asRoot: true,
      sharedNetwork: true,
      command: (config, dir) =>
        `${sudo}env PATH="$PATH" ${dockerd} --config-file ${dir}/daemon.json --host unix://${dir}/docker.sock --pidfile ${dir}/docker.pid --exec-root ${dir}/exec --data-root ${dataRoot}/${method}-${config.id} --containerd-namespace ${tag}-${method}-${config.id} --containerd-plugins-namespace ${tag}-${method}-${config.id}-plugins ${config.flags}`.trim(),
    });

  d.rungs = [
    // Always checked first: a healthy daemon on the default socket is used as it is.
    { method: "preinstalled-running", run: () => d.running() },
    {
      method: "preinstalled-started",
      run: async () => {
        if (probe.dockerd !== "yes")
          return d.skip("preinstalled-started", "the image has no dockerd");

        if (!canBeRoot(probe))
          return d.skip("preinstalled-started", "not root and no passwordless sudo");

        return (
          (await d.mayShareNetwork("preinstalled-started")) &&
          rootful("preinstalled-started", "dockerd")
        );
      },
    },
    {
      method: "static-rootful",
      run: async () => {
        if (!canBeRoot(probe)) return d.skip("static-rootful", "not root and no passwordless sudo");

        if (probe.arch !== "x86_64")
          return d.skip("static-rootful", `no pinned static bundle for ${probe.arch}`);

        return (
          (await d.mayShareNetwork("static-rootful")) &&
          (await d.fetchStatic(false)) &&
          rootful("static-rootful", `${g.tools}/docker/dockerd`)
        );
      },
    },
    {
      method: "rootless",
      run: async () => {
        const missing = rootlessPrerequisites(probe);

        if (missing) return d.skip("rootless", missing);

        if (probe.arch !== "x86_64")
          return d.skip("rootless", `no pinned static bundle for ${probe.arch}`);

        return (
          (await d.fetchStatic(true)) &&
          d.ladder({
            method: "rootless",
            configs: rootlessConfigs,
            socket: (dir) => `${dir}/xdg/docker.sock`,
            asRoot: false,
            // rootlesskit gives the daemon a network namespace of its own.
            sharedNetwork: false,
            command: (config, dir) =>
              `env XDG_RUNTIME_DIR=${dir}/xdg sh -c 'mkdir -p -m 700 "$XDG_RUNTIME_DIR" && exec "$0" "$@"' ${g.tools}/docker-rootless-extras/dockerd-rootless.sh --config-file ${dir}/daemon.json --data-root ${dir}/data ${config.flags}`.trim(),
          })
        );
      },
    },
    {
      method: "podman",
      run: async () => {
        if (probe.podman === "none") return d.skip("podman", "the image has no podman");

        return d.ladder({
          method: "podman",
          configs: [{ id: "service", flags: "", network: "bridge" }],
          socket: (dir) => `${dir}/podman.sock`,
          asRoot: false,
          sharedNetwork: false,
          command: (_config, dir) =>
            `podman --root ${dir}/storage --runroot ${dir}/run system service --time=0 unix://${dir}/podman.sock`,
        });
      },
    },
  ];

  if (!(await d.climb(0))) {
    if (g.signal.aborted)
      throw new StageFailure("timeout", "attempt timeout", "Aborted during the daemon ladder");
    // The ladder finished failing: that is the verdict, whatever the log reads below do.
    d.record.finished = true;
    await bounded(d.collectLogs(), 20_000);

    const tried = d.record.tries
      .map((t) => `${t.method}/${t.config}: ${t.error ?? "?"}`)
      .join("; ");

    const skipped = d.record.skipped.map((s) => `${s.method}: ${s.reason}`).join("; ");
    throw new StageFailure(
      "daemon",
      d.record.tries.length ? "no daemon method worked" : "no daemon method available",
      tail(`tried: ${tried || "none"}. skipped: ${skipped || "none"}`, 2000),
    );
  }

  d.record.finished = true;
  await d.ensureCompose();

  return d;
}

/**
 * The line of a pull or start output that says the daemon's storage driver itself cannot work here,
 * refused as invalid, unsupported or not permitted; or null. It names the graph or storage driver,
 * or a mount whose filesystem is an overlay or whose target is the daemon's image-layer storage
 * (/var/lib/docker, /var/lib/containers). A full disk, a layer's file ownership (lchown), a mount
 * namespace, a container's runtime mount (/proc, /sys), a failed download or extraction, or
 * anything else is the workload's failure, never a reason to change daemons.
 */
export function storageIncompatibility(output: string): string | null {
  const driver = /graph ?driver|storage[- ]driver|driver not supported/i;

  // "error creating overlay mount to …", "failed to mount overlay", "mount … type overlay",
  // containerd's 'mount source: "overlay", …, fstype: overlay' (Docker 29's image store), or a mount
  // onto the layer store itself.
  const storageMount =
    /\boverlay\w*\s+mount\b|\bmount(?:ing)?\s+"?overlay|\btype\s+"?overlay|\b(?:mount source|fstype):\s*"?overlay\b|\bmount(?:ing)?\b[^\n]*\b(?:to|at|on(?:to)?)\s+"?\/var\/lib\/(?:docker|containers)\//i;

  const notStorage =
    /no space left on device|\bl?chown\b|mount namespace|rootfs at "|mounting "(?:proc|sysfs|cgroup2?|devpts|mqueue|tmpfs)"/i;

  const line = output
    .split("\n")
    .find(
      (text) =>
        (driver.test(text) || storageMount.test(text)) &&
        /(?:invalid argument|not supported|operation not permitted)/i.test(text) &&
        !notStorage.test(text),
    );

  return line === undefined ? null : line.slice(0, 300);
}

async function composePath(
  g: Guest,
  plan: ServicesPlan,
  probe: Probe,
  /** Receives the ladder's record as soon as it exists, so a later failure keeps it. */
  keep: (daemon: Daemon) => void,
  env: ServicesEnvironment,
  sandboxId: string | null,
): Promise<Outcome> {
  const daemon = await getDaemon(
    g,
    probe,
    plan.daemonReadyMs ?? 45_000,
    keep,
    composeProject(plan.attemptId),
  );

  daemon.owner = { provider: plan.entry.name, attemptId: plan.attemptId, sandboxId };
  daemon.onProject = env.onProject?.bind(env) ?? null;

  const ports = plan.ports ?? servicePorts;
  const composeEnv = { SBX_PG_PORT: String(ports.postgres), SBX_REDIS_PORT: String(ports.redis) };
  await portsFree(g, ports);

  try {
    // A storage-driver failure (pull or container start) moves to another daemon (vfs first) and
    // starts over from the pull; every try stays in the phases.
    for (;;) {
      const pull = await g.step("image-pull", daemon.composeCommand("pull --quiet"), {
        cwd: guest.app,
        env: composeEnv,
        timeoutMs: stepTimeoutMs.imagePull,
      });

      // From `up` on the project may hold containers, networks or volumes on this daemon: its
      // obligation is journaled first, and `up` is never sent when that write fails.
      if (pull.ok)
        try {
          await daemon.claim();
        } catch (error) {
          throw new StageFailure(
            "services-start",
            "project journal write failed",
            error instanceof Error ? error.message : String(error),
          );
        }

      const start = pull.ok
        ? await g.step("services-start", daemon.composeCommand("up -d --no-build"), {
            cwd: guest.app,
            env: composeEnv,
            timeoutMs: stepTimeoutMs.servicesStart,
          })
        : null;

      if (start?.ok) break;
      const failed = start ?? pull;

      const incompatible = storageIncompatibility(failed.output);

      if (!g.signal.aborted && incompatible !== null && (await daemon.switchStorage(incompatible)))
        continue;

      throw new StageFailure(
        g.signal.aborted ? "timeout" : start ? "services-start" : "image-pull",
        failed.timedOut
          ? `${start ? "services-start" : "image-pull"} timed out`
          : `${start ? "services-start" : "image-pull"} exited ${failed.exitCode}`,
        tail(failed.output),
      );
    }

    return await waitAndTest(g, ports);
  } catch (error) {
    const result = await g
      .exec(
        `${daemon.composeCommand("ps -a")} 2>&1; ${daemon.composeCommand("logs --tail 40")} 2>&1`,
        {
          cwd: guest.app,
          env: composeEnv,
          timeoutMs: 60_000,
        },
      )
      .catch(() => ({ output: "diagnostics command failed" }));

    g.diagnostics("compose-diagnostics", result.output);
    throw error;
  }
}

// ---------------------------------------------------------------- metrics

/** The last phase with this name: a retried step counts its try that decided the outcome. */
const spanOf = (phases: readonly Phase[], name: string) => lastOf(phases, (p) => p.name === name);

const okMs = (phase: Phase | undefined) => (phase?.ok ? phase.endedAt - phase.startedAt : null);

/** Durations from the recorded phases. Each is null unless its phases passed. */
export function metricsOf(path: ServicePath, phases: readonly Phase[], green: boolean): Metrics {
  const ready = spanOf(phases, "services-ready");
  const upload = spanOf(phases, "upload");
  const tests = spanOf(phases, "tests");
  const daemonPhases = phases.filter((p) => p.name.startsWith("daemon-"));
  const daemonOk = lastOf(daemonPhases, (p) => p.name.startsWith("daemon-start:") && p.ok);
  const firstDaemon = daemonPhases[0];

  const servicesStart =
    path === "compose"
      ? okMs(spanOf(phases, "services-start"))
      : (() => {
          const first = spanOf(phases, "postgres-init");
          const last = spanOf(phases, "redis-start");

          const all = ["postgres-init", "postgres-start", "redis-start"].every(
            (name) => spanOf(phases, name)?.ok,
          );

          return all && first && last ? last.endedAt - first.startedAt : null;
        })();

  const upStart = path === "compose" ? firstDaemon : spanOf(phases, "bundle-upload");

  return {
    createMs: okMs(spanOf(phases, "create")),
    probeMs: okMs(spanOf(phases, "probe")),
    uploadMs: okMs(upload),
    daemonReadyMs: daemonOk && firstDaemon ? daemonOk.endedAt - firstDaemon.startedAt : null,
    imagePullMs: okMs(spanOf(phases, "image-pull")),
    servicesStartMs: servicesStart,
    servicesReadyMs: okMs(ready),
    servicesUpMs: ready?.ok && upStart ? ready.endedAt - upStart.startedAt : null,
    testsMs: green ? okMs(tests) : null,
    readyToGreenMs: green && upload && tests ? tests.endedAt - upload.startedAt : null,
  };
}

// ---------------------------------------------------------------- attempt

/** How long past its own timeout an attempt may run before cleanup starts regardless. */
export const deadlineGraceMs = 30_000;

/** How long cleanup waits for `compose down -v` of the attempt's project. */
export const composeDownMs = 45_000;

/** The arguments every teardown of an attempt's project uses, in the attempt and in recovery. */
const composeDown = "down -v --remove-orphans --timeout 5";

/** Resolves after `ms`, unless `signal` fires first; never rejects. */
const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/** The attempt's mutable state, shared by its body and its cleanup. */
interface AttemptState {
  box: Sandbox | null;
  app: AttemptApp | null;
  guest: Guest | null;
  probe: Probe | null;
  probeError: string | null;
  daemon: DaemonRecord | null;
  deletionConfirmed: boolean;
  createdAt: number | null;
  /** A sandbox a failed create reported (SandboxError.sandboxId). */
  stray: string | null;
  /** The create request: cleanup must tell one still in flight from one that settled. */
  allocation: Allocation;
  /** Cleanup has started: the body must not send a create any more. */
  closed: boolean;
  /** The compose path's daemon, for the version, storage driver and logs read after the verdict. */
  daemonRef: Daemon | null;
}

/** What one create call came back with, success or failure, never a rejection. */
type CreateResult =
  | { readonly kind: "box"; readonly box: Sandbox }
  | { readonly kind: "error"; readonly error: Error };

type Allocation =
  | { readonly kind: "not-submitted" }
  | { readonly kind: "pending"; readonly result: Promise<CreateResult> }
  | { readonly kind: "settled" };

/**
 * SDK error codes that show a create was refused before anything was allocated: bad input or an
 * unsupported option. Every other failure without a sandbox ID (auth, quota, not_found, provider,
 * timeout, a non-SandboxError) may follow an allocation, as Modal's and Instabox's can, and boxd's
 * when its own cleanup of a half-made machine fails, so it stays unresolved.
 */
const refusedCreateCodes: ReadonlySet<string> = new Set(["invalid_argument", "unsupported"]);

/** `work`, or nothing once `ms` passes; never rejects. For bookkeeping that must not stall cleanup. */
const bounded = (work: Promise<unknown> | undefined, ms = 30_000) =>
  Promise.race([Promise.resolve(work).catch(() => {}), after(ms)]);

export async function runServicesAttempt(
  plan: ServicesPlan,
  env: ServicesEnvironment,
): Promise<AttemptRecord> {
  const now = env.now ?? Date.now;
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(new Error(`Attempt reached its ${plan.timeoutMs} ms timeout`)),
    plan.timeoutMs,
  );

  const phases: Phase[] = [];
  const startedAt = now();
  const sandboxIds: string[] = [];

  // Written by the attempt body and read by cleanup, which may run while the body is still going.
  const st: AttemptState = {
    box: null,
    app: null,
    guest: null,
    probe: null,
    probeError: null,
    daemon: null,
    deletionConfirmed: true,
    createdAt: null,
    stray: null,
    allocation: { kind: "not-submitted" },
    closed: false,
    daemonRef: null,
  };

  let outcome: Outcome;

  const adopt = async (created: Sandbox) => {
    if (sandboxIds.includes(created.id)) return;
    sandboxIds.push(created.id);
    st.deletionConfirmed = false;
    await env.onSandbox(plan.entry.name, created.id);
    await bounded(st.app?.created(created.id));
  };

  /**
   * A failed create can still have allocated a sandbox. Its ID is recorded first (so cleanup
   * deletes it even if the journal stalls). Without an ID, an unknown outcome leaves deletion
   * unconfirmed and the run stops admitting on this provider; a definitive refusal costs nothing.
   */
  const failedCreate = async (error: Error) => {
    if (error instanceof SandboxError && error.sandboxId) {
      st.stray = error.sandboxId;

      if (!sandboxIds.includes(st.stray)) sandboxIds.push(st.stray);
      st.deletionConfirmed = false;
      await bounded(env.onSandbox(plan.entry.name, st.stray));
    } else if (!(error instanceof SandboxError) || !refusedCreateCodes.has(error.code))
      st.deletionConfirmed = false;

    await bounded(st.app?.failed(error));
  };

  const body = async (): Promise<Outcome> => {
    if (plan.entry.beforeAttempt)
      st.app = await plan.entry.beforeAttempt(plan.attemptId, controller.signal);
    await env.onSubmit?.(plan.entry.name, plan.attemptId);
    // Timed from the request itself, not the journal write before it.
    const submitted = now();
    st.createdAt = submitted;

    // The attempt may have timed out while the journal was written, or cleanup may already have
    // run: never start a create then, and journal that it was not sent so recovery does not look
    // for it. Checked synchronously right before the request, so nothing slips between.
    if (st.closed || controller.signal.aborted) {
      await bounded(env.onNotSent?.(plan.entry.name, plan.attemptId));
      throw new StageFailure(
        "timeout",
        st.closed ? "attempt deadline" : "attempt timeout",
        "No create was sent",
      );
    }

    {
      // No abort signal: the SDK would reject at once on abort and lose a late allocation's ID.
      // The attempt's hard deadline bounds the wait instead, and cleanup takes over the result.
      const result: Promise<CreateResult> = createSandbox(plan.entry.provider, {
        ...plan.entry.create?.(plan.track),
        labels: plan.entry.runLabelOnly
          ? { ...st.app?.labels, "sandbox-bench-run": plan.ownerLabel }
          : {
              ...st.app?.labels,
              "sandbox-bench-run": plan.ownerLabel,
              "svc-attempt": plan.attemptId,
              "svc-path": plan.path,
            },
      }).then(
        (box): CreateResult => ({ kind: "box", box }),
        (error: Error): CreateResult => ({ kind: "error", error }),
      );

      st.allocation = { kind: "pending", result };
      const settled = await result;
      st.allocation = { kind: "settled" };

      if (settled.kind === "box") st.box = settled.box;
      else {
        await failedCreate(settled.error);
        phases.push({
          name: "create",
          startedAt: submitted,
          endedAt: now(),
          ok: false,
          exitCode: null,
          timedOut: false,
        });
        const { error } = settled;

        throw new StageFailure(
          "create",
          error instanceof SandboxError ? `create failed (${error.code})` : "create failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const box = st.box;
    phases.push({
      name: "create",
      startedAt: submitted,
      endedAt: now(),
      ok: true,
      exitCode: null,
      timedOut: false,
    });

    if (!box) throw new StageFailure("error", "create returned nothing", "");
    await adopt(box);
    const runner = new Guest(box, controller.signal, phases, now);
    st.guest = runner;

    const parsed = await runner.span("probe", async () => {
      await runner.exec(`mkdir -p ${guest.root} /workspace/svc ${guest.app}`, {
        timeoutMs: 30_000,
      });
      await runner.box.files.write(`${guest.root}/probe.sh`, probeScript);

      const result = await runner.exec(`sh ${guest.root}/probe.sh`, {
        timeoutMs: stepTimeoutMs.probe,
      });

      runner.diagnostics("probe", result.output);

      return parseProbe(result.stdout);
    });

    if (parsed.kind === "invalid") {
      st.probeError = parsed.error;
      const phase = phases.at(-1);

      if (phase) phase.ok = false;
      throw new StageFailure("probe", "probe output did not parse", parsed.error);
    }

    st.probe = parsed.probe;

    if (parsed.probe.arch !== "x86_64")
      return {
        kind: "unsupported",
        reason: `no pinned artifacts for ${parsed.probe.arch}`,
        detail:
          "Node 22.23.5, the no-Docker bundle (Postgres 16, Redis 7) and Docker's static binaries are pinned for x86_64 only, so neither path can run here",
      } satisfies Outcome;
    await prepareBase(runner, plan, env);

    return plan.path === "compose"
      ? composePath(
          runner,
          plan,
          parsed.probe,
          (found) => {
            st.daemon = found.record;
            st.daemonRef = found;
          },
          env,
          st.box?.id ?? null,
        )
      : nativePath(runner, plan, env, parsed.probe);
  };

  // The abort signal asks every step to stop; this deadline makes sure cleanup starts even when a
  // step ignores it (a stalled journal write or provider call keeps running, but not the clock).
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () =>
        reject(
          new StageFailure(
            "timeout",
            "attempt deadline",
            `Still running ${plan.deadlineGraceMs ?? deadlineGraceMs} ms after the ${plan.timeoutMs} ms timeout; cleanup started`,
          ),
        ),
      plan.timeoutMs + (plan.deadlineGraceMs ?? deadlineGraceMs),
    );
  });

  try {
    // Closed the moment the race settles, before diagnostics or cleanup await anything.
    outcome = await Promise.race([body(), deadline]).finally(() => {
      st.closed = true;
    });
  } catch (error) {
    if (error instanceof StageFailure) outcome = { kind: "failed", ...pick(error) };
    else if (controller.signal.aborted)
      outcome = {
        kind: "failed",
        stage: "timeout",
        reason: "attempt timeout",
        detail: String(controller.signal.reason),
      };
    else
      outcome = {
        kind: "failed",
        stage: "error",
        reason: "harness or provider error",
        detail: error instanceof Error ? error.message : String(error),
      };

    // After the hard deadline, cleanup comes first: no diagnostics.
    if (
      st.guest &&
      plan.path === "native" &&
      outcome.stage !== "upload" &&
      outcome.reason !== "attempt deadline"
    )
      await Promise.race([nativeDiagnostics(st.guest).catch(() => {}), after(30_000)]);
  } finally {
    st.closed = true;
    clearTimeout(timer);
    clearTimeout(deadlineTimer);
    controller.abort(new Error("Attempt finished"));
  }

  const destroyTimeoutMs = env.destroyTimeoutMs ?? 120_000;
  const cleanupStart = now();

  // A create still in flight at the deadline: wait for its real result within the destroy window.
  // A sandbox that arrives, or an error naming one, is deleted below; a refusal costs nothing;
  // no answer at all stays unresolved for the run's sweep.
  if (st.allocation.kind === "pending") {
    const { result } = st.allocation;
    st.deletionConfirmed = false;
    const late = await Promise.race([result, after(destroyTimeoutMs).then(() => null)]);

    if (late?.kind === "box") {
      st.box = late.box;
      await adopt(late.box).catch(() => {});
    } else if (late?.kind === "error") {
      st.deletionConfirmed = true;
      await failedCreate(late.error);
    } else
      // Still no answer: whatever arrives later is journaled (so the run's final drain deletes it)
      // and deleted here, best effort. The attempt stays unresolved either way.
      env.onLateCleanup?.(
        result.then(async (later) => {
          const id =
            later.kind === "box"
              ? later.box.id
              : later.error instanceof SandboxError
                ? later.error.sandboxId
                : undefined;

          if (!id) return;
          // Deletion starts at once; the journal write runs beside it, not before it.
          await Promise.all([
            bounded(env.onSandbox(plan.entry.name, id)),
            bounded(
              later.kind === "box" ? later.box.destroy() : plan.entry.provider.destroy(id),
              destroyTimeoutMs,
            ),
          ]);
        }),
      );
  }

  // The verdict is final; now this attempt's compose project comes down on the daemon that ran it,
  // then the daemon's version, storage driver and logs are read, each on its own bounded window
  // (the attempt's own signal has fired), before the sandbox goes.
  // Bounded on their own, so they never shorten the destroy window below.
  const postWorkFrom = now();

  if (st.daemonRef && st.guest && st.box) {
    // Separate guests on their own short signals: the workload's signal stays aborted, so a body
    // still running can never start another step. They share the attempt's tool directory.
    const down = new Guest(st.box, AbortSignal.timeout(composeDownMs), [], now, st.guest.tools);
    await bounded(st.daemonRef.down(down, composeDownMs), composeDownMs);
    const post = new Guest(st.box, AbortSignal.timeout(30_000), [], now, st.guest.tools);
    await bounded(st.daemonRef.readMetadata(post), 30_000);
  }

  const postWorkMs = now() - postWorkFrom;

  const target = st.box;
  const strayId = st.stray;
  // The lifetime ends at the confirmed stop (or now, when nothing was there to stop); journal and
  // output writing afterwards are ours, not the provider's.
  let stoppedAt = now();

  // The sandbox may be the only way back to a daemon that was already there: while the project on
  // it did not come down, the sandbox stays, unconfirmed, for recovery to retry its teardown.
  if (projectCleanupOf(st.daemonRef) === "open")
    phases.push({
      name: "destroy",
      startedAt: cleanupStart,
      endedAt: now(),
      ok: false,
      exitCode: null,
      timedOut: false,
      note: "kept: its as-found Compose project did not come down",
    });
  else if (target || strayId) {
    const destroy = target
      ? () => target.destroy()
      : () => plan.entry.provider.destroy(strayId ?? "");

    const left = Math.max(1000, destroyTimeoutMs - (now() - cleanupStart - postWorkMs));
    st.deletionConfirmed = await Promise.race([
      destroy().then(
        () => true,
        () => false,
      ),
      after(left).then(() => false),
    ]);
    stoppedAt = now();
    phases.push({
      name: "destroy",
      startedAt: cleanupStart,
      endedAt: stoppedAt,
      ok: st.deletionConfirmed,
      exitCode: null,
      timedOut: false,
    });
    await bounded(st.app?.destroyed(target?.id ?? strayId ?? ""));
  }

  // A daemon launched inside the sandbox went with it: its project claims are resolved.
  if (st.deletionConfirmed && st.daemonRef) await bounded(st.daemonRef.releaseWithSandbox());

  let outputDir: string | null = null;

  const logs = st.guest?.logs;

  if (env.outputDir && logs?.size)
    try {
      outputDir = join(env.outputDir, plan.attemptId);
      await mkdir(outputDir, { recursive: true });

      for (const [name, text] of logs)
        await writeFile(join(outputDir, `${name.replaceAll(/[^\w.-]/g, "_")}.log`), text);
    } catch {
      outputDir = null;
    }

  const endedAt = now();
  const lifetimeFrom: number | null = st.createdAt;

  return {
    schema: attemptSchemaVersion,
    runId: plan.runId,
    attemptId: plan.attemptId,
    provider: plan.entry.name,
    track: plan.track,
    path: plan.path,
    attempt: plan.attempt,
    sandboxIds,
    startedAt,
    endedAt,
    probe: st.probe,
    probeError: st.probeError,
    daemon: st.daemon,
    phases,
    outcome,
    metrics: metricsOf(plan.path, phases, outcome.kind === "green"),
    deletionConfirmed: st.deletionConfirmed,
    projectCleanup: projectCleanupOf(st.daemonRef),
    cleanup: cleanupStatus(st.deletionConfirmed, projectCleanupOf(st.daemonRef)),
    // From the create request to the confirmed stop whenever a sandbox may exist; a clean refusal
    // costs nothing.
    estimatedUSD:
      lifetimeFrom !== null && (sandboxIds.length > 0 || !st.deletionConfirmed)
        ? env.estimate(stoppedAt - lifetimeFrom)
        : 0,
    artifacts: {
      node: plan.artifacts.node.sha256,
      fixture: plan.artifacts.fixture.sha256,
      native: plan.path === "native" ? plan.artifacts.native.sha256 : null,
    },
    outputDir,
  };
}

/**
 * The attempt's Compose project, apart from its sandbox: `none` when it never came up, `down`
 * once its own `down` exited 0, `with-sandbox` when it did not but the daemon holding it lives
 * inside the sandbox (launched there, or found running there: `Daemon.running` uses no other), so
 * it goes when the sandbox's deletion is confirmed, and `open` otherwise. No sandbox deletion or
 * sweep ever resolves `open`.
 */
export function projectCleanupOf(
  daemon: { readonly projectUsed: boolean; readonly record: DaemonRecord } | null,
): ProjectCleanup {
  if (daemon === null || !daemon.projectUsed) return "none";

  if (daemon.record.down === true) return "down";

  return daemon.record.launched || daemon.record.method === "preinstalled-running"
    ? "with-sandbox"
    : "open";
}

/** Everything the attempt made is gone: its sandbox's deletion is confirmed and no project is open. */
export const cleanupStatus = (deletionConfirmed: boolean, project: ProjectCleanup) =>
  deletionConfirmed && project !== "open" ? "confirmed" : "unconfirmed";

function pick(error: StageFailure) {
  return { stage: error.stage, reason: error.reason, detail: error.detail };
}

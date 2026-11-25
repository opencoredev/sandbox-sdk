/**
 * `bench reap` against the local Docker adapter reads only through the daemon the run used: the
 * same socket and, behind it, the same daemon. Two fake Docker Engine APIs on temp unix sockets
 * stand in for two daemons; no real Docker daemon is touched.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { main } from "../src/cli.js";
import { fingerprintOf } from "../src/connections.js";
import { loadProvider } from "../src/providers.js";
import { fakeDocker, type FakeDocker } from "./docker-fake.js";

const run = "local-reap";
const container = "aaaaaaaaaaaa1111";

const cleanup: (() => Promise<void>)[] = [];

const argv = process.argv;
const exitCode = process.exitCode;

afterEach(async () => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();

  for (const step of cleanup.splice(0).reverse()) await step();
});

async function daemon(id: string, socketPath?: string) {
  const fake = await fakeDocker(id, socketPath);
  cleanup.push(() => fake.close());

  return fake;
}

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "bench-reap-local-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));

  return dir;
}

/** A run's container left running on `docker`, and its journal as the run wrote it. */
async function crashedRun(docker: FakeDocker, out: string) {
  docker.containers.set(container, {
    labels: { "sandbox-sdk": "1", "sandbox-bench-run": run },
    running: true,
  });

  // The adapter as the run built it, with DOCKER_HOST pointing at the run's daemon.
  vi.stubEnv("DOCKER_HOST", docker.host);
  const loaded = await loadProvider("local", process.env);

  if (loaded.kind !== "ready") throw new Error(`local skipped: ${loaded.note}`);
  const fingerprint = await fingerprintOf(loaded.provider);

  await writeFile(
    join(out, "ownership.json"),
    JSON.stringify({
      runId: run,
      connectionFingerprints: fingerprint ? { local: fingerprint } : {},
      resources: [{ provider: "local", id: container, kind: "sandbox", parent: null }],
      apps: [],
    }),
  );
}

const journal = z.object({ resources: z.array(z.object({ id: z.string() })) });

async function reap(out: string, host: string) {
  vi.stubEnv("DOCKER_HOST", host);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  process.argv = [
    "bun",
    "bench",
    "reap",
    "--providers",
    "local",
    "--run",
    run,
    "--timeout-ms",
    "2000",
    "--ownership-visibility-ms",
    "1000",
    "--out",
    out,
  ];
  process.exitCode = 0;
  await main();

  return {
    exitCode: process.exitCode,
    stderr: stderr.mock.calls.map((call) => String(call[0])).join(""),
    journaled: journal
      .parse(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")))
      .resources.map((r) => r.id),
  };
}

/** Requests that read or change containers, as opposed to `/info`. */
const containerRequests = (docker: FakeDocker) =>
  docker.requests.filter((r) => r.includes("/containers"));

describe("bench reap with the local adapter", () => {
  it("with DOCKER_HOST on another daemon, reads nothing there and keeps the running container journaled", async () => {
    const a = await daemon("daemon-a");
    const b = await daemon("daemon-b");
    const out = await directory();

    await crashedRun(a, out);
    const result = await reap(out, b.host);

    // The container still runs on the run's daemon: its entry must stay.
    expect(a.containers.get(container)?.running).toBe(true);
    expect(result.journaled).toEqual([container]);
    expect(containerRequests(b)).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("SKIP local:");
    expect(result.stderr).not.toContain(b.socketPath);
  });

  it("with the run's socket path now served by another daemon, reads nothing and keeps the entry", async () => {
    const dir = await directory();
    const path = join(dir, "docker.sock");
    const a = await daemon("daemon-a", path);
    const out = await directory();

    await crashedRun(a, out);
    await a.close();
    const c = await daemon("daemon-c", path);
    const result = await reap(out, `unix://${path}`);

    expect(result.journaled).toEqual([container]);
    expect(containerRequests(c)).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("SKIP local:");
  });

  it("when the daemon's /info fails at reap, reads nothing and keeps the entry", async () => {
    const a = await daemon("daemon-a");
    const out = await directory();

    await crashedRun(a, out);
    a.daemonId = null;
    a.requests.length = 0;
    const result = await reap(out, a.host);

    expect(result.journaled).toEqual([container]);
    expect(containerRequests(a)).toEqual([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("SKIP local:");
  });

  it("with the run's own daemon, reaps the container and empties the journal", async () => {
    const a = await daemon("daemon-a");
    const out = await directory();

    await crashedRun(a, out);
    const result = await reap(out, a.host);

    expect(result.stderr).not.toContain("SKIP local");
    expect(a.containers.has(container)).toBe(false);
    expect(result.journaled).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

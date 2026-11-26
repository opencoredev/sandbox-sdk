import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { bindConnection, fingerprintOf, reapConnection } from "../../src/connections.js";
import { loadSlotProvider } from "../../src/realistic/cli.js";
import { providerSetup } from "../../src/realistic/setup.js";
import { attributionFor, type SlotProvider } from "../../src/realistic/slots.js";
import { sweep as servicesSweep } from "../../src/services/cli.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const runFile = (providers: string[], connections: Record<string, string>) => ({
  id: "r1",
  ownerLabel: "r1-abcd",
  sdkCommit: "a",
  startedAt: "x",
  endedAt: null,
  location: "evo-1",
  settings: {},
  artifacts: { node: "n", fixture: "f", native: "b" },
  providers,
  connections,
});

const lines = (rows: object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/**
 * Run `services sweep` once per entry of `runs` (its extra arguments) on one folder holding these
 * journals, loading providers with the realistic loader or as `entry`; each run's exit code and
 * output.
 */
async function sweeps(
  files: Record<string, string>,
  entry: SlotProvider | undefined,
  runs: readonly (readonly string[])[],
) {
  const dir = await mkdtemp(join(tmpdir(), "svc-recovery-"));
  const before = process.exitCode;
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const results = [];

  try {
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);

    for (const extra of runs) {
      process.exitCode = undefined;
      stderr.mockClear();
      stdout.mockClear();
      await servicesSweep(
        ["--out", dir, "--run", "r1", ...extra],
        entry === undefined ? undefined : () => Promise.resolve({ kind: "ready", entry }),
      );
      results.push({
        exitCode: process.exitCode,
        stderr: stderr.mock.calls.map(([text]) => String(text)).join(""),
        stdout: stdout.mock.calls.map(([text]) => String(text)).join(""),
        projects: await readFile(join(dir, "projects.jsonl"), "utf8").catch(() => ""),
      });
    }

    return results;
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
    process.exitCode = before;
    await rm(dir, { recursive: true, force: true });
  }
}

/** One `services sweep` run; see {@link sweeps}. */
async function sweep(files: Record<string, string>, entry?: SlotProvider, extra: string[] = []) {
  const [result] = await sweeps(files, entry, [extra]);

  if (result === undefined) throw new Error("no sweep ran");

  return result;
}

const states = (projects: string) =>
  projects
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).state);

describe("sweep uses the connection that created the sandboxes", () => {
  test("a Buddy run in EU is not swept from a shell that reaches the US API", async () => {
    vi.stubEnv("BUDDY_TOKEN", "t");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_REGION", "EU");

    const original = await loadSlotProvider(providerSetup("buddy"), "same-machine", 0);

    if (original.kind !== "ready") throw new Error(original.note);
    const fingerprint = await fingerprintOf(original.entry.provider);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);

    // The same region from a fresh load is the same connection.
    const again = await loadSlotProvider(providerSetup("buddy"), "same-machine", 0);

    if (again.kind !== "ready") throw new Error(again.note);
    expect(await reapConnection(again.entry.provider, fingerprint ?? undefined)).toEqual({
      kind: "same",
    });

    // A shell without BUDDY_REGION reaches Buddy's US API: nothing is listed or deleted there.
    vi.stubEnv("BUDDY_REGION", "");
    const fetch = vi.spyOn(globalThis, "fetch");

    const swept = await sweep({
      "run.json": JSON.stringify(runFile(["buddy"], { buddy: fingerprint ?? "" })),
      "owned.jsonl": lines([{ provider: "buddy", id: "sbx-eu-1", attemptId: "buddy-native-1" }]),
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(swept.exitCode).toBe(1);
    expect(swept.stderr).toContain("buddy: not swept, connection mismatch");
    expect(swept.stdout).toContain('"unreachable":1');
  });
});

describe("recovery tears an as-found project down before it deletes the sandbox", () => {
  /** `connectFailures`: how many of the first connects fail, as a transient 503 would. */
  const setup = async (downExit: number, connectFailures = 0) => {
    const provider = bindConnection(memory(), {});
    const order: string[] = [];
    let failures = connectFailures;

    const box = await createSandbox(provider, {
      labels: { "sandbox-bench-run": "r1-abcd", "svc-attempt": "e2b-compose-1" },
    });

    const exec = provider.exec.bind(provider);
    const destroy = provider.destroy.bind(provider);
    const connect = provider.connect.bind(provider);

    provider.connect = async (id) => {
      if (failures-- > 0) throw new Error("503 Service Unavailable");

      return connect(id);
    };

    provider.exec = async (id, input) => {
      if (!input.command.includes("compose -p")) return exec(id, input);
      order.push(`down ${input.command.includes("DOCKER_HOST='unix:///var/run/docker.sock'")}`);

      return { exitCode: downExit, timedOut: false };
    };

    provider.destroy = async (id) => {
      order.push(`destroy ${id === box.id}`);

      return destroy(id);
    };

    const entry: SlotProvider = {
      name: "e2b",
      provider,
      attribution: attributionFor("e2b").attribution,
      settlementMs: null,
      paddingMs: 0,
    };

    const claim = {
      provider: "e2b",
      attemptId: "e2b-compose-1",
      project: "sbx-e2b-compose-1-abc123",
      daemon: "preinstalled-running/as-found",
      provenance: "as-found",
      sandboxId: box.id,
      state: "pending",
      down: "export DOCKER_HOST='unix:///var/run/docker.sock'; docker compose -p 'sbx-e2b-compose-1-abc123' -f compose.yaml down -v --remove-orphans --timeout 5",
    };

    // A runner that died after up: the claim and the owned ID, and no attempt row.
    const files = {
      "run.json": JSON.stringify(runFile(["e2b"], {})),
      "submissions.jsonl": lines([{ provider: "e2b", attemptId: "e2b-compose-1" }]),
      "owned.jsonl": lines([{ provider: "e2b", id: box.id, attemptId: "e2b-compose-1" }]),
      "projects.jsonl": lines([claim]),
    };

    return { order, files, entry };
  };

  test("a teardown that exits 0 runs on the recorded socket first and resolves the claim", async () => {
    const { order, files, entry } = await setup(0);
    const swept = await sweep(files, entry);

    expect(order[0]).toBe("down true");
    expect(order).toContain("destroy true");
    expect(order.indexOf("destroy true")).toBeGreaterThan(0);
    expect(states(swept.projects)).toEqual(["pending", "down"]);
    expect(swept.stdout).toContain('"openProjects":0');
    expect(swept.stderr).not.toContain("Compose project cleanup unresolved");
  });

  test("a teardown that fails keeps the sandbox and the claim open with the project's full identity", async () => {
    const { order, files, entry } = await setup(1);
    const swept = await sweep(files, entry);

    // Two tries, and the sandbox, the way back to that daemon, is never deleted.
    expect(order).toEqual(["down true", "down true"]);
    expect(states(swept.projects)).toEqual(["pending"]);
    expect(swept.exitCode).toBe(1);
    expect(swept.stdout).toContain('"retained":1');
    expect(swept.stderr).toContain(
      "Kept 1 sandboxes for their unresolved as-found Compose projects: e2b-compose-1 (project sbx-e2b-compose-1-abc123 on e2b sandbox",
    );
    expect(swept.stderr).toContain(
      "Compose project cleanup unresolved for e2b-compose-1 (project sbx-e2b-compose-1-abc123 on e2b sandbox",
    );
  });

  test("a connect that fails once keeps the sandbox, and the next sweep tears down and deletes", async () => {
    const { order, files, entry } = await setup(0, 1);
    const [first, second] = await sweeps(files, entry, [[], []]);

    // The first sweep never reached the guest, so it deleted nothing.
    expect(first?.exitCode).toBe(1);
    expect(first?.stdout).toContain('"retained":1');
    expect(states(first?.projects ?? "")).toEqual(["pending"]);

    expect(order).toEqual(["down true", "destroy true"]);
    expect(second?.exitCode).toBeUndefined();
    expect(second?.stdout).toContain('"retained":0');
    expect(states(second?.projects ?? "")).toEqual(["pending", "down"]);
  });

  test("only --abandon-project deletes a kept sandbox, and its project stays open", async () => {
    const { order, files, entry } = await setup(1);
    const swept = await sweep(files, entry, ["--abandon-project", "e2b-compose-1"]);

    expect(order).toEqual(["down true", "down true", "destroy true"]);
    expect(swept.stdout).toContain('"retained":0');
    expect(swept.exitCode).toBe(1);
    expect(swept.stderr).toContain("Compose project cleanup unresolved for e2b-compose-1");
  });
});

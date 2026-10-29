import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

it("fails the real CLI with explicit sandbox admission coverage evidence", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-admission-"));

  try {
    const run = spawnSync(
      "bun",
      [
        "src/cli.ts",
        "--providers",
        "memory",
        "--runs",
        "2",
        "--scenarios",
        "command",
        "--bursts",
        "",
        "--max-sandboxes",
        "1",
        "--max-dollars",
        "5",
        "--out",
        out,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 20000 },
    );

    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(1);
    const report = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
    expect(report.admissionStopped).toContainEqual(
      expect.objectContaining({
        provider: "memory",
        scenario: "command",
        track: "default",
        reason: expect.stringContaining("Sandbox budget"),
      }),
    );
    expect(await readFile(join(out, "results.md"), "utf8")).toContain("admissionStopped:");
    expect(
      report.cleanup.every((entry: { remaining: string[] }) => entry.remaining.length === 0),
    ).toBe(true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("records every scenario denied by the dollar guard without calling create", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { parseV2 } = await import("../src/v2-config.js");
  const out = await mkdtemp(join(tmpdir(), "bench-dollar-admission-"));

  try {
    const report = await runV2(
      [{ kind: "ready", name: "boat", cloud: false, region: null, provider: memory() }],
      parseV2([
        "--providers",
        "boat",
        "--runs",
        "1",
        "--scenarios",
        "command",
        "--bursts",
        "",
        "--max-dollars",
        "0.000001",
        "--out",
        out,
      ]),
      async () => {},
    );

    expect(report.samples).toEqual([]);
    expect(report.admissionStopped).toEqual(
      ["cold", "command", "destroy"].map((scenario) => ({
        provider: "boat",
        scenario,
        iteration: 0,
        track: "default",
        reason: "Estimated dollar budget reached",
      })),
    );
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it.each(["tenki", "e2b", "upstash", "freestyle"])(
  "records undocumented %s account-cap skips as admission failures",
  async (name) => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const { parseV2 } = await import("../src/v2-config.js");
    const out = await mkdtemp(join(tmpdir(), "bench-cap-"));

    try {
      const report = await runV2(
        [{ kind: "ready", name, cloud: false, region: null, provider: memory() }],
        parseV2([
          "--providers",
          name,
          "--scenarios",
          "burst",
          "--bursts",
          "25",
          "--burst-cohorts",
          "1",
          "--concurrency",
          "25",
          "--out",
          out,
        ]),
        async () => {},
      );

      expect(report.admissionStopped).toEqual([
        expect.objectContaining({
          provider: name,
          scenario: "burst-25/all-ready",
          reason: expect.stringContaining("account cap"),
        }),
      ]);
      expect(report.samples).toEqual([]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  },
);

it("keeps documented Boat K25 exclusions out of admission failures", async () => {
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  const { runV2 } = await import("../src/v2-runner.js");
  const { parseV2 } = await import("../src/v2-config.js");
  const out = await mkdtemp(join(tmpdir(), "bench-policy-cap-"));

  try {
    const report = await runV2(
      [{ kind: "ready", name: "boat", cloud: false, region: null, provider: memory() }],
      parseV2([
        "--providers",
        "boat",
        "--scenarios",
        "burst",
        "--bursts",
        "25",
        "--burst-cohorts",
        "1",
        "--out",
        out,
      ]),
      async () => {},
    );

    expect(report.admissionStopped).toEqual([]);
    expect(report.providers[0]?.note).toContain("documented not-run");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("fails the CLI on cap-only missing coverage", async () => {
  const out = await mkdtemp(join(tmpdir(), "bench-cli-cap-"));

  try {
    const run = spawnSync(
      "bun",
      [
        "src/cli.ts",
        "--providers",
        "memory",
        "--scenarios",
        "burst",
        "--bursts",
        "25",
        "--burst-cohorts",
        "1",
        "--concurrency",
        "25",
        "--out",
        out,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 20000 },
    );

    expect(run.status, run.stderr).toBe(1);
    expect(
      JSON.parse(await readFile(join(out, "results.json"), "utf8")).admissionStopped,
    ).toHaveLength(1);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionRefusal } from "../src/survival.js";
import { boundFake } from "./native-fakes.js";

describe("survival on a provider whose default session ends on schedule", () => {
  it("refuses a Vercel window its 5-minute default session cannot cover, and only that", () => {
    const plan = { windowMs: 300_000, intervalMs: 15_000 };

    expect(sessionRefusal("vercel", plan, 30_000)).toMatch(
      /^vercel's default session ends after 300 s, before the 300 s window and up to 60 s of setup/,
    );
    expect(sessionRefusal("vercel", { windowMs: 225_000, intervalMs: 15_000 }, 30_000)).toBeNull();
    expect(sessionRefusal("e2b", plan, 30_000)).toBeNull();
  });

  it("records a refused Vercel survival cohort as not run without creating a sandbox", async () => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const { parseV2 } = await import("../src/v2-config.js");
    const out = await mkdtemp(join(tmpdir(), "bench-vercel-session-"));
    const provider = boundFake(memory());
    const create = provider.create.bind(provider);
    let creates = 0;

    provider.create = async (...args) => {
      creates++;

      return create(...args);
    };

    try {
      const report = await runV2(
        [{ kind: "ready", name: "vercel", cloud: false, region: null, provider }],
        parseV2([
          "--providers",
          "vercel",
          "--scenarios",
          "survival",
          "--bursts",
          "1",
          "--burst-cohorts",
          "1",
          "--out",
          out,
        ]),
        async () => {},
      );

      expect(creates).toBe(0);
      expect(report.admissionStopped).toContainEqual(
        expect.objectContaining({
          provider: "vercel",
          scenario: expect.stringMatching(/^survival-1\//),
          reason: expect.stringMatching(/^Survival not run: vercel's default session ends/),
        }),
      );
      expect(report.providers.find((p) => p.name === "vercel")?.note).toMatch(/not run: vercel's/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 30_000);
});

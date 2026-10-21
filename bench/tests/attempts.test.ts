import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { checkAttempts, attemptPolicySchema } from "../src/attempts.js";
import { performanceScript } from "../src/perf-script.js";
it("fails missing counts, accepts only explicit not-run reasons", () => {
  const policy = attemptPolicySchema.parse({replacements: [], notRun: [{provider: "boat", suite: "main", scenario: "pause-resume", reason: "Unsupported"}]});
  const rows = checkAttempts([], policy);
  expect(rows.find(r => r.provider === "boat" && r.scenario === "pause-resume")?.pass).toBe(true);
  expect(rows.find(r => r.provider === "e2b" && r.scenario === "cold")?.pass).toBe(false);
  const wildcard = checkAttempts([], {replacements: [], notRun: [{provider: "boat", suite: "burst", scenario: "burst-25/*", reason: "Plan start limit"}]});
  expect(wildcard.find(r => r.provider === "boat" && r.scenario === "burst-25/all-ready")?.pass).toBe(true);
  expect(() => attemptPolicySchema.parse({replacements: [], notRun: [{provider: "boat", suite: "main", scenario: "cold", reason: ""}]})).toThrow();
});
it("omits CDN downloads while preserving TCP and fixed performance kernels", async () => {
  const raw = await readFile(new URL("../probes/perf.py", import.meta.url), "utf8");
  const script = performanceScript(raw, true);
  expect(script).not.toContain("speed.cloudflare.com");
  expect(script).toContain("socket.create_connection");
  expect(script).toContain("results['disk-4k-read-iops']");
  expect(performanceScript(raw, false)).toBe(raw);
  expect(() => performanceScript("changed", true)).toThrow();
});

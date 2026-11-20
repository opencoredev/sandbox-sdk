import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/merge.js";
import { sampleSuite, suiteFor } from "../src/suite.js";
import {
  cohortBoundMs,
  cohortOnly,
  iterationBoundMs,
  parseCohortScenario,
  selectedCohorts,
} from "../src/scenarios.js";
import type { FailureOutcome } from "../src/failure.js";

const failed = (provider: string, scenario: string, outcome: Omit<FailureOutcome, "kind">) =>
  classifyFailure({ provider, scenario, outcome: { kind: "failure", ...outcome } });

describe("failure taxonomy for the new cohorts", () => {
  it("treats refused creates and rate-limited heartbeats as account limits", () => {
    expect(failed("e2b", "survival-10/cold", { note: "Create failed", code: "quota" })).toBe(
      "provider-account-limit",
    );
    expect(failed("e2b", "cpu-burst-25/cold", { note: "Rate limit exceeded for sandboxes" })).toBe(
      "provider-account-limit",
    );
    expect(
      failed("vercel", "survival-10/window", {
        note: "Unresponsive: heartbeat failed",
        cause: { httpStatus: 429 },
      }),
    ).toBe("provider-account-limit");
  });

  it("keeps deaths, hangs and other create errors on the provider", () => {
    expect(
      failed("e2b", "survival-10/window", { note: "Died at 45 s (absent): Sandbox gone" }),
    ).toBe("provider-operation");
    expect(failed("e2b", "cpu-burst-10/cold", { note: "Internal server error" })).toBe(
      "provider-operation",
    );
    expect(failed("e2b", "cpu-burst-10/cpu", { note: "Guest exit 137", code: "quota" })).toBe(
      "provider-operation",
    );
  });

  it("applies the Daytona concurrent-create rule to every cohort kind", () => {
    for (const scenario of ["burst-10/cold", "cpu-burst-10/cold", "survival-25/cold"])
      expect(failed("daytona", scenario, { note: "invalid_argument" })).toBe(
        "provider-account-limit",
      );
  });

  it("leaves the publication suites' classification as it was", () => {
    // The quota code was never an account limit for the readiness bursts or the main suite.
    expect(failed("e2b", "burst-10/cold", { note: "Create failed", code: "quota" })).toBe(
      "provider-operation",
    );
    expect(failed("e2b", "cold", { note: "Rate limit exceeded" })).toBe("provider-operation");
    expect(failed("boat", "cold", { note: "Boat reported quota" })).toBe("provider-account-limit");
  });
});

describe("suites and scenario names", () => {
  it("files cohort rows under their own suite, whatever run they came from", () => {
    expect(sampleSuite("cpu-burst-10/cpu-single", "main")).toBe("cpu-burst");
    expect(sampleSuite("survival-25/window", "main")).toBe("survival");
    expect(sampleSuite("burst-10/cold", "main")).toBe("burst");
    expect(sampleSuite("cpu-sustained-single", "main")).toBe("main");
    const config = (scenarios: string[]) => ({ config: { seed: 45, scenarios, bursts: [10] } });

    expect(suiteFor(config(["survival"]))).toBe("survival");
    expect(suiteFor(config(["cpu-burst"]))).toBe("cpu-burst");
    expect(suiteFor(config(["burst", "survival"]))).toBe("burst");
  });

  it("parses cohort scenarios and recognises their aggregates", () => {
    expect(parseCohortScenario("cpu-burst-10/all-complete")).toEqual({
      kind: "cpu-burst",
      k: 10,
      member: "all-complete",
      aggregate: true,
    });
    expect(parseCohortScenario("survival-3/window")).toMatchObject({
      kind: "survival",
      aggregate: false,
    });
    expect(parseCohortScenario("burst-25/all-ready")).toMatchObject({ aggregate: true });
    expect(parseCohortScenario("cpu-sustained-all")).toBeNull();
  });

  it("selects cohort kinds and normal iterations from --scenarios", () => {
    expect(selectedCohorts(["all"], [10])).toEqual(["burst"]);
    expect(selectedCohorts(["survival"], [10])).toEqual(["survival"]);
    expect(selectedCohorts(["burst", "cpu-burst"], [10])).toEqual(["burst", "cpu-burst"]);
    expect(selectedCohorts(["survival"], [])).toEqual(["survival"]);
    expect(cohortOnly(["survival", "cpu-burst"])).toBe(true);
    expect(cohortOnly(["cpu-sustained"])).toBe(false);
    expect(cohortOnly(["all"])).toBe(false);
  });
});

describe("admission reserves", () => {
  it("keeps the old per-iteration bound unless cpu-sustained runs", () => {
    expect(iterationBoundMs(1000, ["command"])).toBe(19_000);
    expect(iterationBoundMs(1000, ["all"])).toBe(20_000);
    expect(iterationBoundMs(1000, ["cpu-sustained"])).toBe(20_000);
  });

  it("covers a survival member's whole window", () => {
    const plan = { windowMs: 300_000, intervalMs: 15_000 };

    expect(cohortBoundMs("burst", 1000, plan)).toBe(2000);
    expect(cohortBoundMs("cpu-burst", 1000, plan)).toBe(3000);
    expect(cohortBoundMs("survival", 1000, plan)).toBe(304_000);
  });
});

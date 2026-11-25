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
    expect(
      failed("e2b", "cpu-burst-25/cold", { note: "Create failed", cause: { httpStatus: 429 } }),
    ).toBe("provider-account-limit");
    // Wording alone is not a typed signal: it stays the provider's.
    expect(failed("e2b", "cpu-burst-25/cold", { note: "Rate limit exceeded for sandboxes" })).toBe(
      "provider-operation",
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

  it("keeps the Daytona concurrent-create rule to the readiness bursts it was observed in", () => {
    expect(failed("daytona", "burst-10/cold", { note: "invalid_argument" })).toBe(
      "provider-account-limit",
    );

    for (const scenario of ["cpu-burst-10/cold", "survival-25/cold"])
      expect(failed("daytona", scenario, { note: "invalid_argument" })).toBe("provider-operation");
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
    expect(suiteFor(config(["cpu-sustained"]))).toBe("cpu-sustained");
    expect(suiteFor(config(["cpu-burst", "survival"]))).toBe("cpu-burst");
    expect(suiteFor(config(["burst"]))).toBe("burst");
    // A stress run is a stress run by its plan; a readiness burst beside main scenarios is main.
    expect(suiteFor(config(["burst", "survival"]))).toBe("survival");
    expect(suiteFor(config(["command", "burst"]))).toBe("main");
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
    expect(cohortOnly(["cpu-sustained", "burst"])).toBe(false);
  });
});

describe("admission reserves", () => {
  it("keeps the old per-iteration bound unless cpu-sustained runs", () => {
    expect(iterationBoundMs(1000, ["command"])).toBe(19_000);
    // `all` is the publication suite: cpu-sustained runs only when named.
    expect(iterationBoundMs(1000, ["all"])).toBe(19_000);
    expect(iterationBoundMs(1000, ["cpu-sustained"])).toBe(20_000);
  });

  it("covers a member's setup, its work and its cleanup", () => {
    const plan = { windowMs: 300_000, intervalMs: 15_000 };

    expect(cohortBoundMs("burst", 1000, plan)).toBe(2000);
    // Create, fingerprint, staging, the probe; drain, the ownership check and the delete.
    expect(cohortBoundMs("cpu-burst", 1000, plan)).toBe(7000);
    // Create and fingerprint, the window plus its last heartbeat and lookup, the cleanup steps.
    expect(cohortBoundMs("survival", 1000, plan)).toBe(2000 + 302_000 + 3000);
  });
});

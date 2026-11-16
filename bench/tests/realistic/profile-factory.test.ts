import { describe, expect, test } from "vitest";
import { attemptBudget } from "../../src/realistic/cli.js";
import { providerSetup, provisionedFor } from "../../src/realistic/setup.js";

describe("profile factory options", () => {
  const baseten = providerSetup("baseten");

  test("Baseten's build alone mounts the volume, and only it is priced with disk", () => {
    expect(baseten.profileFactory?.build?.volume).toEqual({ sizeGiB: 8, mountPath: "/workspace" });
    expect(baseten.profileFactory?.["fix-and-test"]).toBeUndefined();
    expect(provisionedFor(baseten, "default", "build")).toEqual({
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 8,
    });
    expect(provisionedFor(baseten, "default", "fix-and-test")).toEqual({
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 0,
    });

    const hour = 3_600_000;

    expect(attemptBudget(baseten, "same-machine", hour, "build")).toBeGreaterThan(
      attemptBudget(baseten, "same-machine", hour, "fix-and-test"),
    );
  });

  test("a provider without profile options provisions its track's size for every profile", () => {
    const e2b = providerSetup("e2b");

    expect(provisionedFor(e2b, "same-machine", "build")).toEqual(
      e2b.tracks["same-machine"].provisioned,
    );
  });
});

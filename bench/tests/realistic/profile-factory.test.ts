import { describe, expect, test } from "vitest";
import { attemptBudget } from "../../src/realistic/cli.js";
import {
  providerSetup,
  provisionedAtMost,
  provisionedFor,
  provisionedOf,
} from "../../src/realistic/setup.js";

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

    expect(
      attemptBudget(
        baseten,
        "same-machine",
        hour,
        provisionedFor(baseten, "same-machine", "build"),
      ),
    ).toBeGreaterThan(attemptBudget(baseten, "same-machine", hour));
  });

  test("a recorded attempt is priced with the volume its record names, not today's setup", () => {
    expect(provisionedOf(baseten, "default", { volumeGiB: 8 })).toEqual({
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 8,
    });
    // A record that mounted none says 0, and keeps its price.
    expect(provisionedOf(baseten, "default", { volumeGiB: 0 })).toEqual({
      cpu: 2,
      memoryGiB: 4,
      diskGiB: 0,
    });
    // A Baseten record without the field predates it: whether it mounted a volume is unknown.
    expect(provisionedOf(baseten, "default", {})).toBeNull();
    // Unrecorded spend is budgeted at the largest size the setup provisions.
    expect(provisionedAtMost(baseten, "default").diskGiB).toBe(8);
  });

  test("a provider without profile options provisions its track's size for every profile", () => {
    const e2b = providerSetup("e2b");

    expect(provisionedFor(e2b, "same-machine", "build")).toEqual(
      e2b.tracks["same-machine"].provisioned,
    );
    expect(provisionedOf(e2b, "same-machine", {})).toEqual(e2b.tracks["same-machine"].provisioned);
  });

  test("a recorded attempt is priced with the disk it ran with, not today's setup", () => {
    // Luxor is recorded under its company, Tenki.
    const luxor = providerSetup("tenki");
    const superserve = providerSetup("superserve");

    // Records from before attempts named their disk ran with 5 GB (Luxor) and 4 GiB (Superserve).
    expect(provisionedOf(luxor, "same-machine", {})).toEqual({ cpu: 4, memoryGiB: 8, diskGiB: 5 });
    expect(provisionedOf(superserve, "same-machine", {})).toEqual({
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 4,
    });
    // New records name the 20 GB disk they ran with.
    expect(provisionedOf(luxor, "same-machine", { diskGiB: 20 })).toEqual({
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 20,
    });
    expect(provisionedOf(superserve, "same-machine", { diskGiB: 20 })).toEqual({
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 20,
    });
    // A track whose disk never changed prices an old record at today's size.
    expect(provisionedOf(luxor, "default", {})).toEqual(luxor.tracks.default.provisioned);
    // New attempts provision, and budget, the 20 GB disk.
    expect(provisionedFor(luxor, "same-machine", "build").diskGiB).toBe(20);
    expect(provisionedFor(superserve, "same-machine", "build").diskGiB).toBe(20);
  });
});

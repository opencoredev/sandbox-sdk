import {expect, it} from "vitest";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {unresolvedCleanupReviews} from "../src/ownership.js";
const script = fileURLToPath(new URL("../src/collection-watchdog.py", import.meta.url));
function reasons(report: unknown) {
 const output = spawnSync("python3", [script], {input: JSON.stringify(report), encoding: "utf8", timeout: 5000});
 expect(output.status, output.stderr).toBe(0);
 return JSON.parse(output.stdout);
}
it("ignores absence/release history and reviews still being checked during collection", () => {
 expect(reasons({cleanupReview: [], cleanupResolved: [{id: "gone", resolution: "absent"}], cleanupReleased: [{id: "own"}]})).toEqual([]);
 expect(reasons({cleanupReview: [{id: "target", status: "checking"}], finishedAt: ""})).toEqual([]);
 expect(unresolvedCleanupReviews([{provider: "memory", id: "target", kind: "sandbox", reason: "Checking", status: "checking"}])).toEqual([]);
});
it("stops for unresolved, legacy, or unfinished final checks even with older absent evidence", () => {
 for (const status of ["unresolved", undefined])
  expect(reasons({cleanupReview: [{id: "target", status}], cleanupResolved: [{id: "target", resolution: "absent"}]})).toEqual(["cleanupReview/quarantine"]);
 expect(reasons({cleanupReview: [{status: "checking"}], finishedAt: "2026-10-22T06:00:00Z"})).toEqual(["cleanupReview/quarantine"]);
});
it("retains admission and cost safeguards", () => {
 expect(reasons({admissionStopped: [{}], samples: [{provider: "boxd", scenario: "sandbox-lifetime", estimatedCost: 50}]})).toEqual(["admissionStopped", "modelled reserve >= $100"]);
});

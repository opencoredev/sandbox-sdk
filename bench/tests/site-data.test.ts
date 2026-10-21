import { describe, expect, it } from "vitest";
import { failureReasons, ourFailure, ourFailures, pauseSplit, shortReason } from "../src/site-data.js";

type Row = Parameters<typeof failureReasons>[0][number] & Parameters<typeof pauseSplit>[0][number];

const sample = (over: Partial<Row>): Row => ({
  provider: "daytona",
  suite: "main",
  scenario: "cold",
  outcome: { kind: "sample", value: 1000 },
  phases: {},
  failureClass: null,
  ...over,
});

describe("shortReason", () => {
  it("keeps the first sentence and drops the generic advice", () => {
    expect(
      shortReason("Daytona request failed (invalid_argument). The provider could not complete the operation. Check the sandbox."),
    ).toBe("Daytona request failed (invalid_argument).");
  });
  it("reads a Python traceback as its final exception", () => {
    const note = "Guest exit 1: Traceback (most recent call last):\n  File \"<stdin>\", line 42, in <module>\n    q = mp.Queue()\nFileNotFoundError: [Errno 2] No such file or directory\n";
    expect(shortReason(note)).toBe("FileNotFoundError: [Errno 2] No such file or directory");
  });
  it("reads an HTML error page as its title", () => {
    expect(shortReason("<html> <head><title>502 Bad Gateway</title></head> <body></body></html>")).toBe("502 Bad Gateway");
  });
});

describe("failureReasons", () => {
  it("groups one cause across the tests it hit and skips derived and off-site rows", () => {
    const fail = (scenario: string) =>
      sample({ scenario, outcome: { kind: "failure", note: "Daytona request failed (invalid_argument). Check it." }, failureClass: "provider-operation" });
    const reasons = failureReasons(
      [fail("cpu-single"), fail("git-clone"), fail("network-mbps"), fail("snapshot-total"), sample({ provider: "e2b", outcome: { kind: "failure", note: "Other." } })],
      "daytona",
    );
    expect(reasons).toEqual([
      { kind: "provider-operation", reason: "Daytona request failed (invalid_argument).", count: 2, runs: 1, tests: ["CPU, one core", "git clone"] },
    ]);
  });
});

describe("failureReasons runs", () => {
  it("counts each failing run once, however many derived tests it failed", () => {
    const fail = (scenario: string, sourceIteration: number) =>
      sample({
        scenario,
        sourceRunId: "r1",
        iterationNamespace: "iteration",
        sourceIteration,
        outcome: { kind: "failure", note: "FileNotFoundError: no /dev/shm" },
        failureClass: "provider-operation",
      });
    const [reason] = failureReasons([fail("cpu-single", 0), fail("cpu-all", 0), fail("cpu-single", 1), fail("cpu-all", 1)], "daytona");
    expect(reason?.count).toBe(4);
    expect(reason?.runs).toBe(2);
  });
});

describe("ourFailure", () => {
  const fail = (provider: string, scenario: string, note: string) =>
    sample({ provider, scenario, outcome: { kind: "failure", note }, failureClass: "provider-operation" });
  it("marks our harness and SDK failures as ours", () => {
    expect(ourFailure(fail("superserve", "cpu-single", "Traceback ...\n_multiprocessing.SemLock(\nFileNotFoundError"))).toMatch(/dev\/shm/);
    expect(ourFailure(fail("boxd", "files-10mb", "boxd request timed out. Check boxd configuration and retry."))).toMatch(/10 MB/);
    expect(ourFailure(fail("tenki", "files-10mb", "Request deadline exceeded. Tenki could not honor the request."))).toMatch(/10 MB/);
    expect(ourFailure(fail("tenki", "cold", "Process cancellation could not be confirmed; VM termination was requested."))).toMatch(/cancelled/);
  });
  it("leaves errors the provider returned as the provider's", () => {
    expect(ourFailure(fail("e2b", "command", "E2B request failed. The provider reported unavailable."))).toBeNull();
    expect(ourFailure(fail("daytona", "snapshot", "<html><title>502 Bad Gateway</title></html>"))).toBeNull();
    expect(ourFailure(fail("boat", "preview-first-byte", "getaddrinfo ETIMEOUT box-node-1-3000.on.boat.dev"))).toBeNull();
    expect(ourFailure(fail("freestyle", "preview-first-byte", "Preview HTTP 502, no first byte"))).toBeNull();
  });
  it("keeps our failures out of the provider's list and counts them apart", () => {
    const rows = [fail("tenki", "files-10mb", "Request deadline exceeded."), fail("tenki", "cold", "Tenki request failed (provider). x")];
    expect(failureReasons(rows, "tenki").map((r) => r.reason)).toEqual(["Tenki request failed (provider)."]);
    expect(ourFailures(rows, "tenki")).toEqual([{ reason: "A timeout or error inside our 10 MB file-transfer code", count: 1, runs: 1 }]);
  });
});

describe("pauseSplit", () => {
  it("returns median pause and resume in seconds only when phases were recorded", () => {
    const pr = (pauseMs: number, resumeReadyMs: number) =>
      sample({ scenario: "pause-resume", phases: { pauseMs, resumeReturnedMs: resumeReadyMs - 10, resumeReadyMs } });
    expect(pauseSplit([pr(1000, 2000), pr(3000, 4000), pr(2000, 3000)], "daytona")).toEqual({ pause: 2, resume: 3, n: 3 });
    expect(pauseSplit([sample({ scenario: "pause-resume" })], "daytona")).toBeNull();
  });
});

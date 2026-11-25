import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { processProbe, stoppedVerdict } from "../src/expanded/runtime.js";

const pid = 4242;

describe("runtime-env-isolation process check", () => {
  it("counts a process as stopped only when the probe saw it gone", () => {
    expect(stoppedVerdict({ ok: true, exitCode: 0, timedOut: false, stdout: "gone\n" }, pid)).toBe(
      "process:stopped",
    );
  });

  it("fails a process the probe saw alive", () => {
    expect(() =>
      stoppedVerdict({ ok: true, exitCode: 0, timedOut: false, stdout: "alive\n" }, pid),
    ).toThrow(/survived stop/);
  });

  it("fails a probe that timed out, errored or printed no marker as inconclusive", () => {
    const inconclusive = [
      { ok: false, exitCode: null, timedOut: true, stdout: "" },
      { ok: false, exitCode: 1, timedOut: false, stdout: "" },
      { ok: false, exitCode: 1, timedOut: false, stdout: "gone\n" },
      { ok: true, exitCode: 0, timedOut: false, stdout: "" },
      { ok: true, exitCode: 0, timedOut: false, stdout: "unknown\n" },
    ];

    for (const probe of inconclusive)
      expect(() => stoppedVerdict(probe, pid), JSON.stringify(probe)).toThrow(/could not tell/);
  });

  it("the probe tells a live pid from an exited one in a real shell", () => {
    const probe = (target: number) =>
      spawnSync("/bin/sh", ["-c", processProbe(target)], { encoding: "utf8" }).stdout;

    const exited = spawnSync("/bin/sh", ["-c", "exit 0"]).pid;

    expect(probe(process.pid)).toBe("alive\n");
    expect(probe(exited)).toBe("gone\n");
  });
});

/**
 * Guest output can carry a secret anywhere, and a stop reason keeps only an excerpt of it. Every
 * excerpt must be taken from sanitized text: cut first, and the sanitizer no longer recognises the
 * piece of the secret left at the edge. Each case feeds output whose secrets straddle every cut.
 */
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerSetup } from "../../src/realistic/setup.js";
import { cpuBurstCheck } from "../../src/fairness/cpu-burst.js";
import { cpuNativeCheck, verifyCheckpoints } from "../../src/fairness/cpu-native.js";
import { diskRealCheck } from "../../src/fairness/disk-real.js";
import {
  runCheck,
  type Box,
  type Check,
  type CommandResult,
  type OpenSession,
} from "../../src/fairness/framework.js";
import { judgeMemory, memoryHonestyCheck } from "../../src/fairness/memory-honesty.js";
import { parseNativeOutput, memOutputSchema } from "../../src/fairness/native.js";
import { securityProbe } from "../../src/fairness/security-probe.js";
import { hostBox } from "./host-box.js";

const supported = platform() === "linux" && arch() === "x64";

/** 88 characters, so every cut the checks make (120, 200, 300 from either end) lands inside one. */
const secret = "Qz7vLw2Kp9Rt4Xn8Bm3Hd6Jf".repeat(4).slice(0, 88);
const leaky = `${secret} `.repeat(16);

/** Fails when any 8 characters of the secret survive. */
function expectClean(text: string) {
  for (let at = 0; at + 8 <= secret.length; at++)
    expect(text).not.toContain(secret.slice(at, at + 8));
}

const failed = (stderr: string, stdout = ""): CommandResult => ({
  ok: false,
  exitCode: 1,
  stdout,
  stderr,
  timedOut: false,
});

beforeEach(() => {
  vi.stubEnv("FAIRNESS_TEST_SECRET", secret);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("guest output in reasons", () => {
  it("sanitizes the native output line before quoting it", () => {
    const parsed = parseNativeOutput(`{${leaky}\n`, memOutputSchema);
    expect(parsed.kind).toBe("invalid");
    expectClean(parsed.kind === "invalid" ? parsed.reason : "");
  });

  it("sanitizes a checkpoint line before quoting it", () => {
    const phase = { segments: 2, seconds: 1, workers: 1 };

    for (const line of [`{${leaky}`, `{"mode":"cpu-stream","x":"${leaky}"}`]) {
      const check = verifyCheckpoints({
        stdout: `${line}\n`,
        seed: 1,
        phase,
        firstSeenS: new Map(),
      });

      expect(check.kind).toBe("invalid");
      expectClean(check.kind === "invalid" ? check.reason : "");
    }
  });

  it("sanitizes the mem run's stderr before its tail", () => {
    const judge = () =>
      judgeMemory({
        run: { kind: "returned", exitCode: 1, timedOut: false, stdout: "", stderr: leaky },
        seed: 1,
        memoryMiB: 16,
        fileMiB: 4,
        oomDelta: null,
        liveness: { kind: "present" },
      });

    expect(judge).toThrow();

    try {
      judge();
    } catch (cause) {
      expectClean(cause instanceof Error ? cause.message : "");
    }
  });
});

const setup = providerSetup("e2b");

/** Runs the check on the host, with `override` answering the commands it matches. */
async function stopReason(
  check: Check<unknown>,
  override: (command: string) => CommandResult | Error | null,
  write?: Box["write"],
) {
  const out = await mkdtemp(join(tmpdir(), `fairness-redact-${check.id}-`));
  const progress: string[] = [];

  const open: OpenSession = async () => ({
    kind: "ready",
    session: {
      create: async () => {
        const real = hostBox();

        return {
          ...real,
          run: async (command, options) => {
            const answer = override(command);

            if (answer instanceof Error) throw answer;

            return answer ?? real.run(command, options);
          },
          write: write ?? real.write,
        };
      },
      leftovers: async () => [],
      destroyById: async () => {},
    },
  });

  const outcome = await runCheck(
    check,
    [setup],
    { runId: "redact", out, concurrency: 1 },
    {
      open,
      signal: new AbortController().signal,
      progress: (line) => progress.push(line),
      retryDelayMs: 0,
      lateSweepDelayMs: 0,
    },
  );

  const entry = outcome.report.providers[0];
  expect(entry?.status).toBe("failed");
  expect(entry?.reason ?? "").not.toBe("");
  const files = await readdir(join(out, "providers"));
  const logs = await readdir(join(out, "logs"));

  const persisted = await Promise.all([
    ...files.map((f) => readFile(join(out, "providers", f), "utf8")),
    ...logs.map((f) => readFile(join(out, "logs", f), "utf8")),
  ]);

  for (const text of [entry?.reason ?? "", ...progress, ...persisted]) expectClean(text);

  return entry?.reason ?? "";
}

describe.runIf(supported)("guest output in every check's stop reason", () => {
  const short = { segments: 1, seconds: 0.3, workers: 1 };
  const plan = { single: short, allCore: short, sustained: short };

  it("cpu-native: a failed segment and a burn that did not start", async () => {
    expect(
      await stopReason(cpuNativeCheck(plan, 100), (c) =>
        /' cpu \d/.test(c) ? failed(leaky) : null,
      ),
    ).toMatch(/single segment 1 exited 1/);
    expect(
      await stopReason(cpuNativeCheck(plan, 100), (c) =>
        c.includes("nohup") ? failed(leaky) : null,
      ),
    ).toMatch(/did not start/);
  }, 60_000);

  it("native install: every failed way in", async () => {
    const install = (c: string) => (c.includes(".sbx-native") ? failed(leaky) : null);

    // The upload throws, then the base64 copy fails.
    expect(
      await stopReason(diskRealCheck({ randomSeconds: 0.3, sizeMiB: 64 }), install, async () => {
        throw new Error(leaky);
      }),
    ).toMatch(/Could not install sbx-native: files: .*; base64: exit 1/);

    // The upload works but no directory runs it, then the base64 copy fails.
    expect(await stopReason(memoryHonestyCheck({ memoryMiB: 64, fileMiB: 16 }), install)).toMatch(
      /files: no directory could run it/,
    );
  }, 60_000);

  it("disk-real: no directory and a failed disk run", async () => {
    const check = diskRealCheck({ randomSeconds: 0.3, sizeMiB: 64 });

    expect(await stopReason(check, (c) => (c.includes("df -Pk") ? failed(leaky) : null))).toMatch(
      /No writable directory/,
    );
    expect(
      await stopReason(check, (c) => (/' disk '/.test(c) ? failed(leaky, leaky) : null)),
    ).toMatch(/sbx-native disk exited 1/);
  }, 60_000);

  it("memory-honesty: a mem run with no kill evidence", async () => {
    const check = memoryHonestyCheck({ memoryMiB: 64, fileMiB: 16 });

    expect(
      await stopReason(check, (c) => (/' mem /.test(c) ? failed(leaky, leaky) : null)),
    ).toMatch(/no kill evidence/);
    expect(await stopReason(check, (c) => (/' mem /.test(c) ? new Error(leaky) : null))).toMatch(
      /mem exec failed/,
    );
  }, 60_000);

  it("security-probe: a probe cut short", async () => {
    expect(
      await stopReason(securityProbe, (c) => (c.includes("@@version") ? failed(leaky) : null)),
    ).toMatch(/Probe exited 1/);
  }, 30_000);

  it("cpu-burst-10: sandboxes that could not be prepared", async () => {
    expect(
      await stopReason(cpuBurstCheck({ cohortSize: 2, cohortSeconds: 0.3 }), (c) =>
        c.includes("/proc/uptime") ? new Error(leaky) : null,
      ),
    ).toMatch(/Only 0 sandboxes/);
  }, 30_000);
});

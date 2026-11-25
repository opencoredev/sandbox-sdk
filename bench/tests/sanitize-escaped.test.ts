import { afterEach, describe, expect, it, vi } from "vitest";
import { verifySegment } from "../src/sustained-cpu.js";
import { sanitize } from "../src/v2-runner.js";

const secret = 'Hy4"Np8\\Vc2-Gs6Wb9Tk';

afterEach(() => vi.unstubAllEnvs());

describe("sanitize with JSON-escaped secrets", () => {
  it("redacts a secret as written and as a JSON string escapes it", () => {
    vi.stubEnv("FAKE_SERVICE_PASSWORD", secret);

    const escaped = JSON.stringify(secret).slice(1, -1);

    expect(escaped).not.toBe(secret);
    expect(sanitize(`raw ${secret} and json {"p":"${escaped}"}`)).toBe(
      'raw [REDACTED] and json {"p":"[REDACTED]"}',
    );
  });

  it("keeps a JSON-escaped secret out of a sustained segment's malformed-line excerpt", () => {
    vi.stubEnv("FAKE_SERVICE_PASSWORD", secret);

    const line = `{"segment":1,"password":${JSON.stringify(secret)}`;

    const check = verifySegment({
      stdout: `${line}\n`,
      seed: 1,
      workers: 1,
      targetSeconds: 1,
      chunkSteps: 1,
      hostExecS: 1,
    });

    expect(check).toEqual({
      kind: "invalid",
      reason: 'Output is not JSON: {"segment":1,"password":"[REDACTED]"',
    });
  });
});

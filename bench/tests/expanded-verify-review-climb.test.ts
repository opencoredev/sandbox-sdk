import type { Labels, SandboxInfo } from "@opencoredev/sandbox-sdk";
import { describe, expect, it } from "vitest";
import { cleanupFailure, runLabel } from "../scripts/climb-check-expanded.js";

const runId = "run-1";

/** A provider whose listing answers with `listed`, recording the labels it was asked for. */
function fakeProvider(listed: () => Promise<SandboxInfo[]>) {
  const asked: Labels[] = [];

  return {
    asked,
    list(labels: Labels) {
      asked.push(labels);

      return listed();
    },
  };
}

function sandbox(id: string): SandboxInfo {
  return { id, labels: { [runLabel]: runId }, state: "running", createdAt: 0 };
}

describe("climb check cleanup", () => {
  it("passes when the run's own label lists no sandboxes", async () => {
    const provider = fakeProvider(async () => []);

    expect(await cleanupFailure(provider, runId)).toBeNull();
    expect(provider.asked).toEqual([{ [runLabel]: runId }]);
  });

  it("fails when the listing fails, instead of reading it as zero leaks", async () => {
    const provider = fakeProvider(async () => {
      throw new Error("connect ENOENT /run/user/1000/podman/podman.sock");
    });

    expect(await cleanupFailure(provider, runId)).toMatch(/could not list.*ENOENT/);
  });

  it("fails and names every sandbox the run left behind", async () => {
    const provider = fakeProvider(async () => [sandbox("a1"), sandbox("b2")]);

    expect(await cleanupFailure(provider, runId)).toBe("leaked 2 sandbox(es): a1, b2");
  });
});

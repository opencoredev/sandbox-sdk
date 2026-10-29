import { it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { writeOwnership, verifyRunOwnership } from "../src/ownership.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  rename: vi.fn((await original<typeof import("node:fs/promises")>()).rename),
}));

it("retains the previous complete journal if replacement is interrupted", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "ownership-"));
  const path = join(directory, "ownership.json");

  try {
    await writeOwnership(path, '{"resources":["old"]}');
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("interrupted before rename"));
    await expect(writeOwnership(path, '{"resources":["new"]}')).rejects.toThrow("interrupted");
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ resources: ["old"] });
    expect(await fs.readdir(directory)).toEqual(["ownership.json"]);
    await writeOwnership(path, '{"resources":["new"]}');
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ resources: ["new"] });
  } finally {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each(["lag", "wrong-run", "wrong-sdk", "unreadable"])(
  "bounds exact-ID visibility retries without trusting %s labels",
  async (mode) => {
    vi.useFakeTimers();
    const backing = memory();

    const info = await backing.create({
      labels: { "sandbox-bench-run": "run", "sandbox-sdk": "1" },
    });

    let attempt = 0;

    const list = vi.fn(async () => {
      attempt++;

      if (mode === "unreadable") throw new Error("metadata unavailable");

      return [
        {
          ...info,
          labels:
            mode === "wrong-run"
              ? { "sandbox-bench-run": "foreign", "sandbox-sdk": "1" }
              : mode === "wrong-sdk"
                ? { "sandbox-bench-run": "run", "sandbox-sdk": "0" }
                : attempt < 3
                  ? {}
                  : info.labels,
        },
      ];
    });

    try {
      const proof = verifyRunOwnership({ ...backing, list }, info.id, "run", 30000, 30000);
      await vi.runAllTimersAsync();
      expect(await proof).toBe(mode === "lag");

      if (mode === "unreadable") {
        expect(list.mock.calls.length).toBeGreaterThan(1);
        expect(list.mock.calls.length).toBeLessThan(25);
      } else expect(list.mock.calls.length).toBe(mode === "lag" ? 3 : 1);
    } finally {
      vi.useRealTimers();
      await backing.destroy(info.id);
    }
  },
);

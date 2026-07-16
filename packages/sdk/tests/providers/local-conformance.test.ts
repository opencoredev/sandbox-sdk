import { expect, test } from "bun:test";
import { local } from "../../src/providers/local";
import { runConformance } from "../../src/testing";

test("Local passes the reusable conformance suite", async () => {
  const results = await runConformance({
    create: { provider: local() },
    commands: {
      success: "true",
      stdout: "printf stdout",
      stderr: "printf stderr >&2",
      nonzero: "exit 2",
      timeout: "sleep 1",
      background: "sleep 1",
      stdin: 'read value; printf "$value"',
    },
  });
  expect(results.filter((result) => result.status === "failed")).toEqual([]);
}, 15_000);

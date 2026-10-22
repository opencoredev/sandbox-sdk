import { describe, expect, test } from "vitest";
import { countedFailures } from "../src/merge.js";

const row = (scenario: string, sandboxId: string | null) => ({ provider: "e2b", scenario, sandboxId, outcome: { kind: "failure" as const, note: "test" } });

describe("countedFailures", () => {
  test("keeps each preview-first-byte attempt on one sandbox", () => {
    expect(countedFailures([row("preview-first-byte", "box-1"), row("preview-first-byte", "box-1")])).toHaveLength(2);
  });
  test("counts a retried delete once per sandbox, including burst members and restores", () => {
    for (const scenario of ["destroy", "burst-10/destroy", "restore-destroy"])
      expect(countedFailures([row(scenario, "box-1"), row(scenario, "box-1"), row(scenario, "box-2")])).toHaveLength(2);
  });
  test("keeps failures without a sandbox id", () => {
    expect(countedFailures([row("destroy", null), row("destroy", null)])).toHaveLength(2);
  });
});

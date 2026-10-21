import { describe, expect, it } from "vitest";
import { publicTables } from "../src/site-data.js";

describe("publicTables", () => {
  it("drops baseline rows and notes but keeps other providers and run logs", () => {
    const md = [
      "| Provider | Cold |",
      "|---|---|",
      "| local | 0.54 |",
      "| e2b | 4.81 |",
      "| main | local | cold | 542 |",
      "| main | e2b | cold | 4810 |",
      "local: Reference baseline only.",
      "e2b: Billed per second.",
      'Flags/config: {"providers":["local","e2b"]}',
    ].join("\n");
    const out = publicTables(md);
    expect(out).not.toMatch(/\| local \|/);
    expect(out).not.toContain("local: Reference baseline");
    expect(out).toContain("| e2b | 4.81 |");
    expect(out).toContain("| main | e2b | cold | 4810 |");
    expect(out).toContain("e2b: Billed per second.");
    expect(out).toContain('Flags/config: {"providers":["local","e2b"]}');
  });
});

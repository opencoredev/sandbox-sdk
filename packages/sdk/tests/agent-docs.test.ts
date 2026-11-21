// The agent skill and the root security policy are read outside the docs site, so nothing else
// checks them against the code. These tests keep them on the current API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import * as sdk from "../src/index.js";

const repo = join(import.meta.dirname, "../../..");
const skill = readFileSync(join(repo, "skills/sandbox-sdk/SKILL.md"), "utf8");
const security = readFileSync(join(repo, "SECURITY.md"), "utf8");

/** Pre-1.0 names that no longer exist, and what replaced them. */
const removed: [RegExp, string][] = [
  [/\bwithSandbox\b/, "await using, or destroy() in finally"],
  [/\brequireCapability\b/, "hasCapability()"],
  [/\b(?:sandbox|box)\.raw\b/, "box.native"],
  [/\b(?:sandbox|box)\.ports\b/, "box.preview(port)"],
  [/\b(?:sandbox|box)\.snapshots\b/, "box.snapshot()"],
  [/\b(?:sandbox|box)\.stop\(\)/, "box.destroy() or box.close()"],
  [/`stop\(\)`/, "destroy() or close()"],
  [/\bExposedPort\b/, "Preview { url, headers }"],
  [/createSandbox\(\{/, "createSandbox(provider, options)"],
  [/\bAscii Box\b/, "the current provider list"],
];

describe.each([
  ["skills/sandbox-sdk/SKILL.md", skill],
  ["SECURITY.md", security],
])("%s uses the current API", (_file, text) => {
  test.each(removed)("no %s (use %s)", (pattern) => {
    expect(text).not.toMatch(pattern);
  });
});

describe("skills/sandbox-sdk/SKILL.md names only things that exist", () => {
  test("every subpath it imports or names is a package export", () => {
    const subpaths = [...skill.matchAll(/@opencoredev\/sandbox-sdk(\/[a-z0-9-]+)?/g)].map(
      (match) => `.${match[1] ?? ""}`,
    );

    expect(subpaths.length).toBeGreaterThan(0);
    expect(subpaths.filter((path) => !(path in pkg.exports))).toEqual([]);
  });

  test("the root functions it names are exported", () => {
    for (const name of ["createSandbox", "connectSandbox", "hasCapability"]) {
      expect(skill).toContain(name);
      expect(name in sdk).toBe(true);
    }
  });
});

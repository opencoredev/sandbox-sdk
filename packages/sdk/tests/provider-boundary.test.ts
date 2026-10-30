// The E2B adapter is written against the public adapter boundary only, so it can move to a package
// its maintainers own: every import is a Node builtin, a file in its own directory, or `/provider`.
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const directory = new URL("../src/providers/e2b/", import.meta.url);

const allowed = (specifier: string) =>
  specifier.startsWith("node:") ||
  /^\.\/[\w-]+\.js$/.test(specifier) ||
  specifier === "../../provider.js";

// Static import and re-export statements. Doc comments that show `import("e2b")` are the caller's code.
const statement = /^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms;

test("the E2B adapter imports nothing from the core but /provider", () => {
  const files = readdirSync(directory).filter((name) => name.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(0);

  const outside = files.flatMap((name) =>
    [...readFileSync(new URL(name, directory), "utf8").matchAll(statement)].flatMap((match) =>
      allowed(match[1] ?? "") ? [] : [`${name}: ${match[1]}`],
    ),
  );

  expect(outside).toEqual([]);
});

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { externalPackages } from "../scripts/externals.js";

const src = join(import.meta.dirname, "../src");

const files = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .map((file) => join(src, file));

const packageName = (spec: string) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

test("every peer dependency is on the explicit external list", () => {
  expect(
    Object.keys(pkg.peerDependencies).filter((name) => !externalPackages.includes(name)),
  ).toEqual([]);
});

test("every package src imports, statically or lazily, is external, so none can be bundled", () => {
  const specifiers = new Set<string>();

  for (const file of files) {
    const code = readFileSync(file, "utf8");

    for (const match of code.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"'.][^"']*)["']/g,
    ))
      specifiers.add(packageName(match[1]!));
  }

  // Messages quote `import("${binding.package}")`; those templates are not imports.
  const packages = [...specifiers].filter(
    (name) => !name.includes("${") && !name.startsWith("node:") && !builtinModules.includes(name),
  );

  expect(packages.length).toBeGreaterThan(5);
  expect(packages.filter((name) => !externalPackages.includes(name))).toEqual([]);
});

test("the core has no runtime dependencies", () => {
  expect(Object.keys(("dependencies" in pkg ? pkg.dependencies : undefined) ?? {})).toEqual([]);
});

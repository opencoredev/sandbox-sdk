// Writes package.json's version into src/version.ts. The root `version-packages` script runs it after
// `changeset version`, so the User-Agent header always names the published version.
import { readFileSync, writeFileSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

const path = new URL("../src/version.ts", import.meta.url);
const source = readFileSync(path, "utf8");

const next = source.replace(
  /export const version = "[^"]*";/,
  `export const version = "${pkg.version}";`,
);

if (!next.includes(`"${pkg.version}"`))
  throw new Error("src/version.ts has no version constant to update");

writeFileSync(path, next);

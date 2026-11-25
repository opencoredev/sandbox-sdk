import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { z } from "zod";

type Manifest = {
  devDependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const manifest: Manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const triples = {
  "darwin-arm64": "darwin-arm64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
} satisfies Record<string, string>;

const report = z
  .object({ header: z.object({ glibcVersionRuntime: z.string().optional() }) })
  .parse(process.report.getReport());

const glibc = report.header.glibcVersionRuntime !== undefined;

const published =
  `${process.platform}-${process.arch}` in triples && (process.platform !== "linux" || glibc);

it("pins each Microsandbox platform package to the microsandbox version", () => {
  const version = manifest.devDependencies.microsandbox;

  for (const platform of Object.values(triples)) {
    expect(manifest.optionalDependencies?.[`@superradcompany/microsandbox-${platform}`]).toBe(
      version,
    );
  }
});

it.runIf(published)("loads the Microsandbox native binding the adapter's create needs", () => {
  const native: unknown = createRequire(import.meta.url)("microsandbox/native");

  expect(native).toBeTypeOf("object");
});

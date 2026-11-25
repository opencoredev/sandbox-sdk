import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

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

const triple = Object.entries(triples).find(
  ([host]) => host === `${process.platform}-${process.arch}`,
)?.[1];

it("pins each Microsandbox platform package to the microsandbox version", () => {
  const version = manifest.devDependencies.microsandbox;

  for (const platform of Object.values(triples)) {
    expect(manifest.optionalDependencies?.[`@superradcompany/microsandbox-${platform}`]).toBe(
      version,
    );
  }
});

it.runIf(triple !== undefined)(
  "loads the Microsandbox native binding the adapter's create needs",
  () => {
    const native: unknown = createRequire(import.meta.url)("microsandbox/native");

    expect(native).toBeTypeOf("object");
  },
);

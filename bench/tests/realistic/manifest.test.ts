import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactSchema,
  dependenciesOf,
  expand,
  parseManifest,
  toolchainSchema,
} from "../../src/realistic/manifest.js";
import { buildFixture, type Fixture, type ManifestInput } from "./fixture.js";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await buildFixture();
});

afterAll(() => fixture.cleanup());

type ProfileInput = ManifestInput["profiles"][string];

type StepInput = ProfileInput["steps"][number];

/** A variant of the fixture's profile, serialised for `parseManifest`. */
const variant = (mutate: (profile: ProfileInput) => ProfileInput) => {
  const raw: ManifestInput = structuredClone(fixture.manifestInput);
  const profile = raw.profiles["fix-and-test"];

  if (!profile) throw new Error("fixture profile");
  raw.profiles["fix-and-test"] = mutate(profile);

  return JSON.stringify(raw);
};

const withSteps = (mutate: (steps: StepInput[]) => StepInput[]) =>
  variant((profile) => ({ ...profile, steps: mutate(profile.steps) }));

describe("harness manifest", () => {
  it("parses the fixture and fills frozen defaults", () => {
    const profile = fixture.manifest.profiles["fix-and-test"];

    expect(profile?.kind).toBe("fix-and-test");
    expect(profile?.steps[0]?.check.exit).toBe(0);
    expect(profile && dependenciesOf(profile, 0)).toEqual([]);
    expect(profile && dependenciesOf(profile, 3)).toEqual(["patch-a"]);
  });

  it("refuses unknown commands, forward dependencies and duplicate ids", () => {
    expect(() =>
      parseManifest(
        withSteps((steps) => [
          ...steps,
          { id: "x", phase: "workload", op: { kind: "command", name: "nope" } },
        ]),
      ),
    ).toThrow(/unknown command nope/);
    expect(() =>
      parseManifest(
        withSteps((steps) => [
          {
            id: "clone",
            phase: "prepare",
            op: { kind: "command", name: "clone" },
            dependsOn: ["install"],
          },
          ...steps.slice(1),
        ]),
      ),
    ).toThrow(/not earlier/);
    expect(() => parseManifest(withSteps((steps) => [...steps, ...steps.slice(0, 1)]))).toThrow(
      /Duplicate step id/,
    );
  });

  it("needs a test-count check for fix-and-test and an output-file check for build", () => {
    expect(() =>
      parseManifest(
        withSteps((steps) => steps.map((step) => ({ ...step, check: { exit: "any" } }))),
      ),
    ).toThrow(/checks test counts/);
    expect(() => parseManifest(variant((profile) => ({ ...profile, kind: "build" })))).toThrow(
      /output files exist/,
    );
  });

  it("expands SBX-95's {vcpu} placeholder and the harness directories", () => {
    expect(
      expand("vitest --maxWorkers={vcpu} --dir {workdir} {cache}/store {toolchain} {pm} {other}", {
        vcpu: 4,
        workdir: "/w",
        cache: "/w/.rw/cache",
        toolchain: "/w/.rw/toolchain",
        pm: "/w/.rw/pm",
      }),
    ).toBe("vitest --maxWorkers=4 --dir /w /w/.rw/cache/store /w/.rw/toolchain /w/.rw/pm {other}");
  });

  const sbx95 = "/home/leo/agents/realistic-workloads/manifest.json";

  it.skipIf(!existsSync(sbx95))("reads SBX-95's concrete fields with the same schemas", () => {
    const source = z
      .object({
        toolchains: z.record(z.string(), toolchainSchema),
        profiles: z.object({
          "fix-and-test": z.object({
            dependencyCache: z.object({
              archives: z.object({ "x86-64": artifactSchema, arm64: artifactSchema }),
            }),
            patches: z.record(z.string(), z.object({ file: z.string(), sha256: z.string() })),
            minFreeDiskGiB: z.number(),
            env: z.record(z.string(), z.string()),
          }),
        }),
      })
      .parse(JSON.parse(readFileSync(sbx95, "utf8")));

    expect(source.toolchains["node-24"]?.tarballs["x86-64"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.profiles["fix-and-test"].env.UV_THREADPOOL_SIZE).toBe("{vcpu}");
  });
});

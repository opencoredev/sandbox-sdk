import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { runV2 } from "../src/v2-runner.js";
import { parseV2 } from "../src/v2-config.js";
import { writeV2 } from "../src/v2-report.js";
import { mergeSources, readSource } from "../src/merge.js";
import { siteData } from "../src/site-data.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** One real collection over the offline memory fake, priced as Boat, read back as merge does. */
async function collect(run: string, args: string[], death = false) {
  const dir = await mkdtemp(join(tmpdir(), `bench-site-${run}-`));
  dirs.push(dir);
  let heartbeats = 0;
  const provider = memory();

  provider.register("cat", async ({ stdout }) => {
    // The fourth heartbeat deletes one sandbox behind the harness's back.
    if (death && ++heartbeats === 4) {
      const [victim] = await provider.list({});

      if (victim) await provider.destroy(victim.id);
    }

    stdout("4f9c1d1e-8b2a-4c1e-9d3f-0a1b2c3d4e5f\n");

    return 0;
  });

  await runV2(
    [{ kind: "ready", name: "boat", cloud: false, region: null, provider }],
    parseV2([
      "--providers",
      "boat",
      "--run",
      run,
      "--out",
      dir,
      "--ownership-visibility-ms",
      "500",
      ...args,
    ]),
    (report) => writeV2(report, dir),
  );

  return readSource(dir);
}

it("exports burst survival under stress and leaves every older field unchanged", async () => {
  const main = await collect("main-run", ["--runs", "2", "--bursts", "", "--scenarios", "command"]);

  const survival = await collect(
    "survival-run",
    [
      "--scenarios",
      "survival",
      "--bursts",
      "3",
      "--burst-cohorts",
      "1",
      "--concurrency",
      "3",
      "--survival-window-ms",
      "2000",
      "--survival-heartbeat-ms",
      "1000",
    ],
    true,
  );

  const before = siteData(mergeSources([main]));
  const after = siteData(mergeSources([main]), "default", mergeSources([survival]));
  const { stress, ...older } = after;
  const { stress: empty, ...olderBefore } = before;

  expect(older).toEqual(olderBefore);
  expect(empty).toEqual({
    observations: 0,
    runs: [],
    selectionRemoved: {},
    cpuSustained: [],
    cpuBurst: [],
    burstSurvival: [],
  });

  expect(stress.runs).toEqual([
    { id: "survival-run", suite: "survival", samples: survival.samples.length },
  ]);
  expect(stress.burstSurvival).toEqual([
    {
      k: 3,
      providers: [
        {
          provider: "boat",
          requestedSize: null,
          template: null,
          windowS: 2,
          heartbeatS: 1,
          cohorts: 1,
          incomplete: { cohorts: 0, members: 0 },
          attempted: 3,
          survived: 2,
          createFailed: { total: 0, accountLimit: 0, clientNetwork: 0, provider: 0 },
          died: 1,
          unresponsive: 0,
          interrupted: 0,
          windowFailures: { accountLimit: 0, clientNetwork: 0, provider: 1 },
          survivalRate: Number((2 / 3).toFixed(4)),
        },
      ],
    },
  ]);
}, 30_000);

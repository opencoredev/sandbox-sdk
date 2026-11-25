import { afterAll, beforeAll, describe } from "vitest";
import { maritime } from "../src/providers/maritime/index.js";
import { runConformance } from "../src/testing.js";
import { maritimeFake, type MaritimeFake } from "./maritime-fake.js";

let fake: MaritimeFake;

beforeAll(async () => {
  fake = await maritimeFake();
});

afterAll(async () => {
  await fake.close();
});

// The fake runs real processes in a temporary directory, so the whole portable surface runs through the
// adapter's commands, files, previews and snapshots with no account.
describe("Maritime adapter against the local fake", () => {
  runConformance(() => maritime({ apiKey: "fake-key", baseUrl: fake.url }), {
    live: true,
    snapshotExpiry: "refused",
    unsupported: {
      httpProbe: "the fake's preview URLs are never served",
      gitPush: "the fake runs commands on the host, where /tmp/sdk-bare is shared between runs",
    },
  });
});

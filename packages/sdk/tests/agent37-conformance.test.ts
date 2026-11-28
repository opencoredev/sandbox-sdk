import { afterAll, beforeAll, describe } from "vitest";
import { agent37 } from "../src/providers/agent37/index.js";
import { runConformance } from "../src/testing.js";
import { agent37Fake, type Agent37Fake } from "./agent37-fake.js";

let fake: Agent37Fake;

beforeAll(async () => {
  fake = await agent37Fake();
});

afterAll(async () => {
  await fake.close();
});

// The fake runs real processes in a temporary directory, so the whole portable surface runs through the
// adapter's commands, files, previews and snapshots with no account.
describe("Agent 37 adapter against the local fake", () => {
  runConformance(
    () => agent37({ apiKey: "fake-key", baseUrl: fake.url, execUrl: `${fake.url}/exec` }),
    {
      live: true,
      snapshotExpiry: "refused",
      unsupported: {
        httpProbe: "the fake's preview URLs are never served",
        gitPush: "the fake runs commands on the host, where /tmp/sdk-bare is shared between runs",
      },
    },
  );
});

import { afterAll, beforeAll, describe } from "vitest";
import { buddy } from "../src/providers/buddy/index.js";
import { runConformance } from "../src/testing.js";
import { buddyFake, type BuddyFake } from "./buddy-fake.js";

let fake: BuddyFake;

beforeAll(async () => {
  fake = await buddyFake();
});

afterAll(async () => {
  await fake.close();
});

// The fake runs real processes in a temporary directory, so the whole portable surface runs through the
// adapter's bridge, staging, files, previews and snapshots with no account.
describe("Buddy adapter against the local fake", () => {
  runConformance(() => buddy(fake.options), {
    live: true,
    snapshotExpiry: "refused",
    unsupported: {
      httpProbe: "the fake's preview URLs are never served",
      gitPush: "the fake runs commands on the host, where /tmp/sdk-bare is shared between runs",
    },
  });
});

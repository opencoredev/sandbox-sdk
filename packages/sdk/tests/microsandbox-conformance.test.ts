import { afterAll, beforeAll, describe } from "vitest";
import { createMicrosandboxProvider } from "../src/providers/microsandbox/provider.js";
import { runConformance } from "../src/testing.js";
import { microsandboxFake, type MicrosandboxFake } from "./microsandbox-fake.js";

let fake: MicrosandboxFake;

beforeAll(async () => {
  fake = await microsandboxFake();
});

afterAll(async () => {
  await fake.close();
});

// The fake's REST control plane and its mock `microsandbox` peer run real processes in a temporary
// directory, so the whole portable surface runs through the adapter's commands, files, Services and
// snapshots with no account.
describe("Microsandbox adapter against the local fake", () => {
  runConformance(
    () =>
      createMicrosandboxProvider(
        { apiKey: "msb_fake_key_0123456789", baseUrl: fake.url, computeType: "standard" },
        async () => fake.peer,
      ),
    {
      live: true,
      snapshotExpiry: "refused",
      unsupported: {
        httpProbe: "the fake's Service URLs are never served",
        gitPush: "the fake runs commands on the host, where /tmp/sdk-bare is shared between runs",
      },
    },
  );
});

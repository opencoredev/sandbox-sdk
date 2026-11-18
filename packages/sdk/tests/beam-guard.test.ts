import { beamOpts } from "@beamcloud/beam-js";
import { afterEach, expect, test } from "vitest";
import { beam } from "../src/providers/beam/index.js";

// beam-js keeps one global client per process; these tests leave it as they found it.
const before = { ...beamOpts };

afterEach(() => {
  Object.assign(beamOpts, before);
});

test("a provider for another account than beam-js already uses is refused before any request", async () => {
  beamOpts.token = "native-account-token-aaaa";
  beamOpts.workspaceId = "native-workspace";

  const provider = beam({ token: "adapter-account-token-bbbb", workspaceId: "native-workspace" });

  await expect(provider.create({ labels: {} })).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

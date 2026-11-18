import { beamOpts } from "@beamcloud/beam-js";
import client from "@beamcloud/beam-js/lib/client";
import { afterEach, expect, test } from "vitest";
import { beam } from "../src/providers/beam/index.js";

// beam-js keeps one global configuration and client per process; these tests restore both.
const before = { ...beamOpts };

afterEach(() => {
  Object.assign(beamOpts, before);
  Object.defineProperty(client, "_client", {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

test("a provider for another account than beam-js's settings is refused before any request", async () => {
  beamOpts.token = "native-account-token-aaaa";
  beamOpts.workspaceId = "native-workspace";

  const provider = beam({ token: "adapter-account-token-bbbb", workspaceId: "native-workspace" });

  await expect(provider.create({ labels: {} })).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

test("a provider is refused when beam-js's cached client holds another token, settings aside", async () => {
  // axios instances are callable functions carrying their defaults.
  const cached = Object.assign(() => {}, {
    defaults: {
      baseURL: "https://app.beam.cloud",
      headers: { Authorization: "Bearer native-account-token-aaaa" },
    },
  });

  Object.defineProperty(client, "_client", { value: cached, writable: true, configurable: true });
  beamOpts.token = "adapter-account-token-cccc";
  beamOpts.workspaceId = "ws";

  const provider = beam({ token: "adapter-account-token-cccc", workspaceId: "ws" });

  await expect(provider.create({ labels: {} })).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

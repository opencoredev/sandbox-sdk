import { beamOpts } from "@beamcloud/beam-js";
import client from "@beamcloud/beam-js/lib/client";
import { afterEach, expect, test } from "vitest";
import { beam } from "../src/providers/beam/index.js";
import { isNumber, isObject } from "../src/shared/narrow.js";

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

// These two configure beam-js for one account, which the module then keeps; they run last.
const sameAccount = {
  token: "adapter-account-token-dddd",
  workspaceId: "ws-d",
  // Nothing listens here, so beam-js's create fails at once without leaving the machine.
  gatewayUrl: "http://127.0.0.1:1",
  requestTimeoutMs: 4321,
};

test("beam-js's own client gets the provider's request timeout", async () => {
  const provider = beam(sameAccount);

  await expect(provider.create({ labels: {} })).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(beamOpts.timeout).toBe(4321);
  expect(cachedTimeout()).toBe(4321);
});

test("a provider re-checks beam-js's account before every fresh create", async () => {
  const provider = beam(sameAccount);

  await expect(provider.create({ labels: {} })).rejects.toMatchObject({ code: "outcome_unknown" });

  // Code using beam-js directly switches it to another account and drops its client.
  beamOpts.token = "native-account-token-eeee";
  Object.defineProperty(client, "_client", {
    value: undefined,
    writable: true,
    configurable: true,
  });

  await expect(provider.create({ labels: {} })).rejects.toMatchObject({
    code: "invalid_argument",
  });
});

/** The timeout on beam-js's cached axios client, which is a function carrying its defaults. */
function cachedTimeout(): number | undefined {
  const holder: object = client;

  if (!("_client" in holder)) return undefined;
  const cached = holder._client;

  if (!(cached instanceof Function) || !("defaults" in cached) || !isObject(cached.defaults))
    return undefined;
  const defaults = cached.defaults;

  return "timeout" in defaults && isNumber(defaults.timeout) ? defaults.timeout : undefined;
}

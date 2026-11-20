import { beamOpts } from "@beamcloud/beam-js";
import client from "@beamcloud/beam-js/lib/client";
import { afterEach, expect, test } from "vitest";
import { cachedAuthorization } from "../src/providers/beam/errors.js";
import { beam } from "../src/providers/beam/index.js";
import { isNumber, isObject } from "../src/shared/narrow.js";

// beam-js keeps one global configuration and client per process; these tests restore both. Its
// own file, because the adapter remembers the one account it configured beam-js for.
const before = { ...beamOpts };

afterEach(() => {
  Object.defineProperty(beamOpts, "token", {
    value: before.token,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  Object.assign(beamOpts, before);
  Object.defineProperty(client, "_client", {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

const account = {
  token: "adapter-account-token-ffff",
  workspaceId: "ws-f",
  // Nothing listens here, so beam-js's create fails at once without leaving the machine.
  gatewayUrl: "http://127.0.0.1:1",
};

test("code that switches beam-js's token just after the adapter configures it cannot move the create", async () => {
  let token = beamOpts.token;

  Object.defineProperty(beamOpts, "token", {
    enumerable: true,
    configurable: true,
    get: () => token,
    set: (value: string) => {
      token = value;

      // Direct beam-js use, one microtask after the adapter set its token.
      if (value === account.token)
        queueMicrotask(() => {
          token = "native-account-token-gggg";
        });
    },
  });

  const provider = beam(account);

  await expect(provider.create({ labels: {} })).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(cachedAuthorization(client)?.authorization).toBe(`Bearer ${account.token}`);
});

test("two first creates at once give beam-js's client the first one's timeout", async () => {
  const fast = beam({ ...account, requestTimeoutMs: 150 });
  const slow = beam({ ...account, requestTimeoutMs: 9000 });

  await Promise.all([
    fast.create({ labels: {} }).catch(() => {}),
    slow.create({ labels: {} }).catch(() => {}),
  ]);

  expect(cachedTimeout()).toBe(150);
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

/**
 * Preloaded (`bun --preload`) into the CLI subprocesses tests start, so they stay offline: a fetch
 * to anything but loopback fails as it would without a network. The CLI's optional egress lookup
 * (ipinfo.io) then records null instead of leaving the machine.
 */
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const online = globalThis.fetch;

async function offline(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);

  if (!loopback.has(url.hostname)) throw new TypeError(`Network disabled in tests: ${url.host}`);

  return online(input, init);
}

globalThis.fetch = Object.assign(offline, online);

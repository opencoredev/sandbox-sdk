/**
 * Preloaded (`bun --preload`) into the CLI subprocesses tests start, so they stay offline and say
 * so when they try not to. A fetch to anything but loopback is refused and recorded, even when
 * the caller catches the error; at exit the process prints each refused request and exits with
 * `blockedExitCode`, so the test that started it fails. A loopback response that redirects off
 * loopback is refused the same way, instead of being followed.
 *
 * One request is expected and answered here, not refused: the CLI's optional egress lookup
 * (`collectMetadata`, https://ipinfo.io/json) gets a 503, so the run records a null location as
 * it would offline.
 */
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const egressLookup = "https://ipinfo.io/json";
const online = globalThis.fetch;
const blocked: string[] = [];

/** Exit status of a process that tried to leave the machine. */
export const blockedExitCode = 86;

/** Printed before the refused requests at exit; tests can look for it too. */
export const blockedMarker = "offline-preload: blocked network requests:";

function refuse(url: URL): never {
  blocked.push(`${url.protocol}//${url.host}${url.pathname}`);
  throw new TypeError(`Network disabled in tests: ${url.host}`);
}

/** The method and body a redirect keeps, as `fetch` follows it. */
function redirected(status: number, request: Request): RequestInit {
  const changesToGet =
    status === 303 || ((status === 301 || status === 302) && request.method === "POST");

  return changesToGet
    ? { method: "GET", headers: request.headers, redirect: "manual" }
    : { method: request.method, headers: request.headers, body: request.body, redirect: "manual" };
}

async function offline(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let request = new Request(input, init);
  const mode = request.redirect;

  for (let hop = 0; hop <= 20; hop++) {
    const url = new URL(request.url);

    if (url.href === egressLookup) return Response.json({ error: "offline test" }, { status: 503 });

    if (!loopback.has(url.hostname)) refuse(url);

    // Redirects are followed here, one hop at a time, so none can leave loopback unseen.
    // A clone keeps the body for a 307 or 308 that resends it.
    const response = await online(new Request(request.clone(), { redirect: "manual" }));
    const location = response.headers.get("location");

    if (mode === "manual" || response.status < 300 || response.status > 399 || !location)
      return response;

    if (mode === "error") throw new TypeError("Redirect refused: redirect mode is error");

    const next = new URL(location, url);
    await response.body?.cancel();

    if (!loopback.has(next.hostname)) refuse(next);

    request = new Request(next, redirected(response.status, request));
  }

  throw new TypeError("Too many redirects");
}

globalThis.fetch = Object.assign(offline, online);

process.on("exit", () => {
  if (blocked.length === 0) return;

  process.stderr.write(`${blockedMarker}\n${blocked.map((url) => `  ${url}\n`).join("")}`);
  process.exitCode = blockedExitCode;
});

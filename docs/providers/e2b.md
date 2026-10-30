# E2B provider

No package besides `@opencoredev/sandbox-sdk` is needed: the adapter calls E2B's API and each sandbox's envd daemon over HTTP. Set `E2B_API_KEY`, or pass `apiKey` to the factory:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b({ template: "base" }));
console.log((await box.run("echo hello")).stdout);
```

`e2b({ apiKey?, template?, domain?, ... })` makes no request until the first provider operation. The `E2BOptions` type documents the rest, including `requestTimeoutMs`, `public`, `autoPause`, and `autoResume`. `box.native` is a `NativeApi` with the `"api"` and `"envd"` planes; `box.native.sdk(() => import("e2b"))` returns the official `Sandbox` if you install `e2b` yourself.

- Keys use metadata lookup and can race across hosts (`keyMode: "best-effort"`). Labels become E2B metadata; listing paginates over SDK-owned running and paused sandboxes. `sandbox-sdk-key` and `sandbox-sdk-deadline` are reserved metadata keys.
- Omitted `size` uses the template's CPU, RAM and disk. Every explicit preset (`small`, `medium`, `large`) and custom size fails with `unsupported`: E2B chooses resources when building the template, not when creating a sandbox.
- `network: "all"` enables internet access. `"none"` uses `allowInternetAccess: false`. `{ allow }` combines E2B `allowOut` with `denyOut: ["0.0.0.0/0"]`. E2B domain rules use HTTP Host/TLS SNI and permit DNS resolution; shared endpoints can admit other destinations on the same endpoint. These are E2B's native network guarantees, not a separate SDK firewall. See [E2B internet access](https://docs.e2b.dev/network/internet-access).
- `timeoutMs` maps to E2B's native timeout with kill-on-expiry. A metadata deadline prevents a fresh client's connect/resume from extending the requested lifetime. If omitted, E2B's default timeout applies. `idleTimeoutMs` fails with `unsupported`: E2B exposes an elapsed-time timeout, not an idle detector. Ports need no advance registration.
- Commands use native stdout/stderr callbacks, stdin delivery and EOF. A separate POSIX session lets timeout/abort kill the entire process group. Templates need `sh`, `bash`, `setsid` and `git`; commands and file operations run as root to make `/workspace` and SDK records accessible.
- Native background commands back process hooks. Process records and logs remain core-owned files, so a new client can reattach. Lost streams reconnect with `commands.connect`. `close()` disconnects local streams and leaves the sandbox running; `destroy()` kills it.
- Pause/resume and snapshots are advertised capabilities. Snapshots return E2B's `snapshotId`; pass it as `from` to create a sandbox from that state. PTYs are not exposed by this adapter. Preview URLs use HTTPS and `getHost(port)`.

The offline E2B tests serve a local E2B control plane and envd behind a `fetch` stub, backed by isolated Linux commands and files, including real Git and HTTP probes. `tests/e2b.live.test.ts` registers the full conformance suite and skips it without `E2B_API_KEY`. With credentials, the suite creates billable sandboxes; run it with `timeout 600s node_modules/.bin/vitest run tests/e2b.live.test.ts --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000` from this package.

Credentials are checked on the first provider operation, not when `e2b()` is constructed. Set `E2B_API_KEY` before create, connect, or list, or pass `apiKey`. `template` defaults to `base`; `domain` falls back to `E2B_DOMAIN`, then `e2b.app`.

# Security policy

## Report a vulnerability

Email `security@opencore.dev` with a minimal reproduction, the affected version and the impact. Do not open a public issue before coordinated disclosure. Do not include production credentials, customer data, file contents or full authenticated preview URLs.

The full guide for users is the [Security page](https://sandbox-sdk.app/docs/reference/security) (`apps/docs/content/reference/security.mdx`). This file summarizes the same model for reviewers.

## Trust boundaries

Sandbox SDK is a library over each provider's API. It adds no isolation layer of its own. The provider you choose supplies the security boundary, its authentication, its network controls and how it hardens the machine.

| Boundary                                       | Who provides it                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Isolation between the sandbox and your servers | The provider: a microVM on E2B and Vercel Sandbox, Daytona's sandbox, a Docker container on `local()` |
| Isolation between sandboxes                    | The provider                                                                                          |
| Who may create and reach sandboxes             | Your provider credentials                                                                             |
| Which user may use which sandbox               | Your app                                                                                              |
| Outbound network                               | The provider, when you set `network`                                                                  |

`local()` runs each sandbox as a Docker container through the Docker Engine API on a local unix socket. A container shares the host kernel, so it is not a VM. The container joins Docker's `bridge` network by default, which allows outbound traffic; pass `network: "none"` to turn it off. Do not run untrusted code from strangers with `local()` on a machine that holds secrets.

`agentos()` is a separate provider. It runs commands in agentOS's virtual process table: JavaScript in V8 isolates and shell tools as WebAssembly over a virtual file system, inside your Node.js process. Its network is open unless you pass `network: "none"` or an allow list. agentOS is beta; review it before you rely on it for untrusted workloads.

`memory()` is not a sandbox. Its handlers run in your process with your privileges. Use it only for tests.

## Network policy fails closed

`network: "none"` and `network: { allow: [...] }` are enforced by the provider. When the provider cannot enforce what you asked, `createSandbox` throws a `SandboxError` with code `unsupported` instead of creating an open sandbox. A capability means the SDK can pass the setting through, not that every provider filters traffic the same way. Check the provider page before you rely on an allow list.

## Credentials, secrets and errors

Provider factories read credentials from their arguments or the provider's own environment variables. Call the SDK from server code only. It adds no telemetry and sends nothing anywhere except to the provider you configured.

Values passed as `secrets` to `createSandbox` become environment variables in the sandbox. The SDK redacts them from command results, process logs, agent tool results and error messages. Streaming redaction holds a bounded prefix (up to 1 MiB) across chunk boundaries so split secrets never escape; if a held suffix exceeds 1 MiB, the held prefix is replaced with `[REDACTED]` and the result is marked truncated (subsequent chunks are processed normally). Code in the sandbox can still read its own environment, raw `box.files.read` is not redacted, and a transformed secret (for example base64) no longer matches.

For background processes on providers with a guest shell, the process shim writes a `sed` program that holds each secret verbatim to `redact.sed` (and, when any secret line exceeds 512 bytes, a companion `redact.txt` used with `awk` for boundary carry and wrapped-line matching) in the process's mode `700` record directory (by default `/tmp/.sandbox-sdk/procs/<name>/`). Both files are mode `600` and are removed when the process exits or is stopped. A process killed with SIGKILL, or a sandbox that dies, can leave them behind until the sandbox is destroyed. The sandbox already holds the same secrets in its environment, so this is not a new exposure, but snapshots taken while a process runs include those files.

`SandboxError.cause` is a redacted string, never the provider's native error object, because native errors can carry credentials. URLs, auth headers, credential-shaped values and registered secrets are replaced with `[REDACTED]`. Treat `message` and `cause` as internal: log them, and show users the `code` and `hint`.

## Previews

`box.preview(port)` returns a `Preview` with a `url` and the `headers` to send with every request. A public preview URL is reachable by anyone who has it. A private preview needs the header from `preview.headers`; keep it on your server and proxy the preview. `local()` previews bind to `127.0.0.1` on the Docker host.

## Snapshots

A snapshot captures the file system, and on some providers memory. It does not remove secrets written to disk or environment variables baked into the image. Treat snapshot IDs as sensitive.

## Cleanup

`box.destroy()` deletes the sandbox at the provider. `box.close()` detaches the handle and leaves the sandbox running so a later call can reattach with its key or ID. Both are safe to call more than once. A sandbox created with `await using` calls `close()` when its scope exits if it has a `key`, and `destroy()` otherwise. If you abort a create with `signal` and the provider finishes it anyway, the SDK destroys the late sandbox.

Cleanup is best effort: provider outages, process crashes or host termination can prevent it. Set `timeoutMs` and `idleTimeoutMs` where the provider supports them, and run `reapSandboxes` on a schedule as a second line of defense.

## What Sandbox SDK does not secure

The SDK does not validate user code, block malicious commands, scan files, rotate credentials, enforce quotas or decide which user owns which sandbox. Agent tool options such as `root`, `allow`, `deny` and `beforeRun` narrow what a model can do but are not a security boundary. Derive sandbox keys from the authenticated user, rate-limit sandbox creation, set lifetime limits and run a reaper.

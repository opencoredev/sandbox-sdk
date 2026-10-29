# Daytona provider


Install `@daytonaio/sdk@^0.225.0` alongside this package, then import `daytona` from `@opencoredev/sandbox-sdk/daytona`. The adapter loads the optional SDK on its first operation. It reads `DAYTONA_API_KEY`, `DAYTONA_API_URL`, and `DAYTONA_TARGET`; `daytona({ apiKey, baseUrl, target })` overrides those values. `requestTimeoutMs` defaults to 30 seconds for control-plane requests. Use `image` for a container image or `snapshot` for an existing Daytona snapshot name. A per-call `from` overrides the configured image or snapshot.

Keys use the `sandbox-sdk-key` label and are best effort. Lists filter by `sandbox-sdk=1`. The adapter does not declare `pause`; an idle timeout stops the sandbox, preserving disk while ending running processes. Snapshots capture the filesystem and return a name accepted by `from`. `box.native` is a typed Daytona `Sandbox`. Terminal support is not exposed.

Size presets map to `{ cpu, memoryMb, diskGb }`: small is `{ 1, 1024, 10 }`, medium is `{ 2, 4096, 20 }`, and large is `{ 4, 8192, 40 }`. Custom sizes require positive integer CPUs, memory in whole GiB (`memoryMb` divisible by 1024), and positive integer disk GiB. Image creation allocates resources directly. Snapshot creation stops, resizes, and restarts before returning; Daytona cannot shrink a snapshot's disk, so a smaller disk request fails and the new sandbox is deleted. Provider quotas and resource limits still apply.

`idleTimeoutMs` rounds up to whole minutes for `autoStopInterval`. A hard `timeoutMs` rounds down to whole minutes for Daytona's wall-clock `ttlMinutes`; values below one minute fail with `unsupported`. Auto-pause is disabled so idle behavior uses stop consistently. Network `none` blocks all traffic. An allowlist uses Daytona's enforced `domainAllowList`; entries must be DNS hostnames without schemes, ports, commas, or wildcards. An empty allowlist blocks all traffic. Unsupported expressions fail before creation.

Commands use fresh sessions with streamed stdout/stderr and separate Linux process groups. Stdin is a private file closed at EOF, including when omitted. Timeout/abort kills the group before returning; an ambiguous launch failure stops the sandbox. Commands require `sh`, `env`, `setsid --wait`, and `/bin/kill` in the image. Background hooks launch core's durable wrapper through a session, preserving records and logs after local detachment. `close()` leaves those processes running.

Previews are private. `preview()` returns the URL and `X-Daytona-Preview-Token` header. Daytona's standard preview-link response has no expiry, so `expiresAt` is omitted rather than guessed. Do not discard the headers when fetching a preview.

The offline Daytona tests replace the SDK transport with an SDK-shaped mock backed by real Linux files and processes, including Git and HTTP. `DAYTONA_API_KEY` enables the entire separate live conformance suite. Run the live suite with `timeout 15m bunx vitest run tests/daytona.live.test.ts --maxWorkers=1` from `packages/sdk`; without credentials it skips every live case.

API mappings were checked against Daytona SDK 0.225.0 and the official [client](https://www.daytona.io/docs/en/typescript-sdk/daytona/), [sandbox](https://www.daytona.io/docs/en/typescript-sdk/sandbox/), [process](https://www.daytona.io/docs/en/typescript-sdk/process/), [filesystem](https://www.daytona.io/docs/en/typescript-sdk/file-system/), and [snapshot](https://www.daytona.io/docs/en/typescript-sdk/snapshot/) references.


`apiUrl` remains a deprecated alias for `baseUrl` until 1.0.0. If both are set, `baseUrl` wins.

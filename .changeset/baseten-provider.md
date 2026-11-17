---
"@opencoredev/sandbox-sdk": minor
---

Add the Baseten provider, `baseten()` from `@opencoredev/sandbox-sdk/baseten`. It runs Baseten Sandboxes through Baseten's official `@basetenlabs/sandbox` SDK (0.5.0), an optional peer. Keys are exact (unique sandbox names). It supports `size` presets and the exact sizes 1 vCPU / 2048 MiB, 2 / 4096 and 4 / 8192 (Baseten sets CPU from memory), `timeoutMs` and `idleTimeoutMs` as Baseten lifecycle policies, public preview URLs without declared ports, and a `volume` option that creates, mounts and deletes a volume per sandbox, for workspaces too large to keep in memory. There is no pause call: Baseten puts an idle sandbox on standby by itself and resumes it on the next request. There are no snapshots, network policies or terminal, and outbound traffic is IPv6-only. Set `BASETEN_API_KEY`, and optionally pass `teamId`, `image`, `region` and `readyTimeoutMs`.

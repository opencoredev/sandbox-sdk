<p align="center">
  <img alt="Sandbox SDK with supported provider logos" src="https://raw.githubusercontent.com/opencoredev/sandbox-sdk/main/Background-with-text.png" width="820" />
</p>

Run the same TypeScript sandbox code on Local, E2B, Daytona, Vercel Sandbox, Upstash Box, Ascii Box, Railway Sandboxes, Tenki, or Smol Machines.

## Install

```bash
bun add @opencoredev/sandbox-sdk
```

Node.js 22 or 24 is supported. Bun 1.3 or newer is also supported.

## Quickstart

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";

await using sandbox = await createSandbox({ provider: local() });
console.log((await sandbox.run("node --version")).stdout);
```

`await using` stops the sandbox automatically when its scope exits, including when an operation throws.

Node.js 24 and Bun run this syntax directly. On Node.js 22, compile TypeScript to ES2022 or use the callback-style `withSandbox()` helper.

## Providers

| Provider                                                        | Runtime                 | Best for                                |
| --------------------------------------------------------------- | ----------------------- | --------------------------------------- |
| [Local](https://sandbox-sdk.app/docs/providers/local)           | AgentOS VM              | Development, CI, and self-hosting       |
| [E2B](https://sandbox-sdk.app/docs/providers/e2b)               | Hosted Linux sandbox    | Coding agents and isolated jobs         |
| [Daytona](https://sandbox-sdk.app/docs/providers/daytona)       | Cloud workspace         | Persistent projects and GPUs            |
| [Vercel Sandbox](https://sandbox-sdk.app/docs/providers/vercel) | Hosted Linux sandbox    | Coding agents and persistent workspaces |
| [Upstash Box](https://sandbox-sdk.app/docs/providers/upstash)   | Durable cloud container | Serverless agents and long-lived state  |
| [Ascii Box](https://sandbox-sdk.app/docs/providers/box)         | Persistent cloud VM     | Full VMs and protected app previews     |
| [Railway](https://sandbox-sdk.app/docs/providers/railway)       | Ephemeral cloud VM      | Durable jobs and private networking     |
| [Smol Machines](https://github.com/smol-machines/smol)          | Local or cloud microVM  | Native Linux agents with checkpointing  |
| [Tenki](https://sandbox-sdk.app/docs/providers/tenki)           | Full Linux VM           | Coding agents, snapshots, pause/resume  |

Local is included. Cloud providers use their official SDKs and credentials.

To use Smol locally or in the cloud, install the optional `smolmachines` package:

```bash
bun add smolmachines
```

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { smol } from "@opencoredev/sandbox-sdk/smol";

await using sandbox = await createSandbox({ provider: smol({ target: "local" }) });
console.log((await sandbox.run("node --version")).stdout);
```

Choose `target: "cloud"` and set `SMOL_CLOUD_TOKEN` for a hosted VM. The native
`Machine` is available as `sandbox.raw` for checkpoints, branching, published
ports, and pause/resume. Cloud port exposure requires ports to be published
before creation and serving before the create call returns; `sandbox.ports.expose`
is therefore unavailable. Local streaming processes are available through
`sandbox.processes.start`; the cloud normalized process handle is unavailable
because canceling its stream cannot guarantee that the guest command stops.

## Documentation

Setup, usage, integrations, and API reference are available at [sandbox-sdk.app/docs](https://sandbox-sdk.app/docs).

## License

[MIT](./LICENSE) © OpenCore

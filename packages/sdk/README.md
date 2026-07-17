<p align="center">
  <img alt="Sandbox SDK with supported provider logos" src="https://raw.githubusercontent.com/opencoredev/sandbox-sdk/main/Background-with-text.png" width="820" />
</p>

Run the same TypeScript sandbox code on Local, E2B, Daytona, Vercel Sandbox, Upstash Box, or Blaxel.

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

| Provider                                                        | Runtime                  | Best for                                |
| --------------------------------------------------------------- | ------------------------ | --------------------------------------- |
| [Local](https://sandbox-sdk.app/docs/providers/local)           | AgentOS VM               | Development, CI, and self-hosting       |
| [E2B](https://sandbox-sdk.app/docs/providers/e2b)               | Hosted Linux sandbox     | Coding agents and isolated jobs         |
| [Daytona](https://sandbox-sdk.app/docs/providers/daytona)       | Cloud workspace          | Persistent projects and GPUs            |
| [Vercel Sandbox](https://sandbox-sdk.app/docs/providers/vercel) | Hosted Linux sandbox     | Coding agents and persistent workspaces |
| [Upstash Box](https://sandbox-sdk.app/docs/providers/upstash)   | Durable cloud container  | Serverless agents and long-lived state  |
| [Blaxel](https://sandbox-sdk.app/docs/providers/blaxel)         | Persistent Linux microVM | Perpetual agent sandboxes               |

Local is included. Cloud providers use their official SDKs and credentials.

## Documentation

Setup, usage, integrations, and API reference are available at [sandbox-sdk.app/docs](https://sandbox-sdk.app/docs).

## License

[MIT](./LICENSE) © OpenCore

<p align="center">
  <img alt="Sandbox SDK with supported provider logos" src="https://raw.githubusercontent.com/opencoredev/sandbox-sdk/main/Background-with-text.png" width="820" />
</p>

Run the same TypeScript sandbox code on Local, E2B, Daytona, Vercel Sandbox, or Upstash Box.

## Install

```bash
bun add @opencoredev/sandbox-sdk
```

Node.js 22 or 24 is supported. Bun 1.3 or newer is also supported.

## Providers

| Provider                                                        | Runtime                 | Best for                                |
| --------------------------------------------------------------- | ----------------------- | --------------------------------------- |
| [Local](https://sandbox-sdk.app/docs/providers/local)           | AgentOS VM              | Development, CI, and self-hosting       |
| [E2B](https://sandbox-sdk.app/docs/providers/e2b)               | Hosted Linux sandbox    | Coding agents and isolated jobs         |
| [Daytona](https://sandbox-sdk.app/docs/providers/daytona)       | Cloud workspace         | Persistent projects and GPUs            |
| [Vercel Sandbox](https://sandbox-sdk.app/docs/providers/vercel) | Hosted Linux sandbox    | Coding agents and persistent workspaces |
| [Upstash Box](https://sandbox-sdk.app/docs/providers/upstash)   | Durable cloud container | Serverless agents and long-lived state  |

Local is included. Cloud providers use their official SDKs and credentials.

## Documentation

Setup, usage, integrations, and API reference are available at [sandbox-sdk.app/docs](https://sandbox-sdk.app/docs).

## License

[MIT](./LICENSE) © OpenCore

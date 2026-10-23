<p align="center">
  <img alt="Sandbox SDK with supported provider logos" src="./Background-with-text.png" width="820" />
</p>

One TypeScript API for running code in a sandbox. Write it once, then run it on E2B, Daytona, Vercel Sandbox, Upstash Box, Railway, Tenki, boxd, Freestyle, Superserve, Boat, or Docker on your own machine.

> 1.0 is in beta. Install it with `@next`; `latest` is still 0.2.

## Install

```bash
npm install @opencoredev/sandbox-sdk@next e2b
```

Add the package for the provider you use. Node.js 22+ and Bun 1.3+ are supported.

## Quickstart

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

await using box = await createSandbox(e2b());
const result = await box.run("python3 -c 'print(1 + 1)'");
console.log(result.stdout);
```

`await using` deletes the sandbox when the scope ends. It runs natively on Node.js 24 and Bun; on Node.js 22, compile with TypeScript.

The [package README](./packages/sdk/README.md) covers every provider, the full API, and agent tools for AI SDK, Mastra, and OpenAI Agents.

## Repository

- [`packages/sdk`](./packages/sdk): the `@opencoredev/sandbox-sdk` package.
- [`apps/docs`](./apps/docs): the documentation site.
- [`apps/web`](./apps/web): the landing page.
- [`bench`](./bench): the provider benchmark harness.
- [`examples`](./examples): runnable examples.
- [`docs`](./docs): the 1.0 design spec and provider reference notes.

## Documentation

Setup, usage, integrations, and API reference are available at [sandbox-sdk.app/docs](https://sandbox-sdk.app/docs).

Maintainer release instructions are in [RELEASING.md](./RELEASING.md).

## License

[MIT](./LICENSE) © OpenCore

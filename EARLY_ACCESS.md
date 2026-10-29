# Sandbox SDK 1.0 beta: early access

`@opencoredev/sandbox-sdk` 1.0.0-beta.1 is one TypeScript API for cloud and local sandboxes. You create a sandbox, run commands, read and write files, start servers, and get preview URLs with the same calls on every provider. The provider is a single factory you pass to `createSandbox`, so supporting several providers comes down to choosing that factory at runtime.

This is a beta. The API can still change before 1.0.0. If something breaks or reads wrong, tell us; the last section says what to include.

## Install

Install from the `next` tag (`latest` is still 0.2, so a plain install gives you the old API):

```sh
npm install @opencoredev/sandbox-sdk@next
```

The docs for this version are at https://v2.sandbox-sdk.app/docs.

Then install the peer package for each provider you plan to use. They are optional peers, so npm will not add them for you. The [peer packages table](https://v2.sandbox-sdk.app/docs/reference/capabilities#peer-packages) names each one and the version range the SDK accepts. Node.js 22+ or Bun 1.3+, ESM only.

Check it works with no account and no Docker:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

await using box = await createSandbox(memory());
await box.files.write("hello.txt", "hello\n");
console.log((await box.run("cat hello.txt")).stdout); // "hello\n"
```

## Providers

| Provider       | Import                                | Environment variables                                                                                         |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| E2B            | `@opencoredev/sandbox-sdk/e2b`        | `E2B_API_KEY`                                                                                                 |
| Daytona        | `@opencoredev/sandbox-sdk/daytona`    | `DAYTONA_API_KEY`; optional `DAYTONA_API_URL`, `DAYTONA_TARGET`                                               |
| Vercel         | `@opencoredev/sandbox-sdk/vercel`     | `VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`                               |
| Upstash Box    | `@opencoredev/sandbox-sdk/upstash`    | `UPSTASH_BOX_API_KEY`; optional `UPSTASH_BOX_BASE_URL`                                                        |
| Railway        | `@opencoredev/sandbox-sdk/railway`    | `RAILWAY_API_TOKEN`, `RAILWAY_ENVIRONMENT_ID`                                                                 |
| Tenki          | `@opencoredev/sandbox-sdk/tenki`      | `TENKI_AUTH_TOKEN` or `TENKI_API_KEY`                                                                         |
| boxd           | `@opencoredev/sandbox-sdk/boxd`       | `BOXD_API_KEY`; optional `BOXD_BASE_URL`                                                                      |
| Freestyle      | `@opencoredev/sandbox-sdk/freestyle`  | `FREESTYLE_API_KEY`                                                                                           |
| Superserve     | `@opencoredev/sandbox-sdk/superserve` | `SUPERSERVE_API_KEY`                                                                                          |
| Boat           | `@opencoredev/sandbox-sdk/boat`       | `BOAT_API_KEY`; optional `BOAT_API_BASE`                                                                      |
| Sandboxer      | `@opencoredev/sandbox-sdk/sandboxer`  | `SANDBOXER_API_KEY`; optional `SANDBOXER_REGION` (`us-east` or `eu-central`, or pass `sandboxer({ region })`) |
| Local (Docker) | `@opencoredev/sandbox-sdk/local`      | none; a running Docker Engine (`DOCKER_HOST` or `/var/run/docker.sock`)                                       |
| agentOS        | `@opencoredev/sandbox-sdk/agentos`    | none                                                                                                          |
| Memory         | `@opencoredev/sandbox-sdk/memory`     | none                                                                                                          |

Every factory also takes its credential as an option, such as `e2b({ apiKey })`, so you can pass per-user keys instead of reading the environment. What each provider supports (pause, snapshots, size, network policy, idle and lifetime limits, ports, labels, key mode, and previews) is in the [capability matrix](https://v2.sandbox-sdk.app/docs/reference/capabilities). A script checks it against the adapters' source, so it stays current. The package README has the full API.

## Switch providers at runtime

```ts
import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";

async function loadProvider(name: string): Promise<Provider> {
  switch (name) {
    case "memory":
      return (await import("@opencoredev/sandbox-sdk/memory")).memory();
    case "local":
      return (await import("@opencoredev/sandbox-sdk/local")).local();
    case "e2b":
      return (await import("@opencoredev/sandbox-sdk/e2b")).e2b();
    case "daytona":
      return (await import("@opencoredev/sandbox-sdk/daytona")).daytona();
    case "vercel":
      return (await import("@opencoredev/sandbox-sdk/vercel")).vercel();
    case "upstash":
      return (await import("@opencoredev/sandbox-sdk/upstash")).upstash();
    default:
      throw new Error(`Unknown SANDBOX_PROVIDER "${name}"`);
  }
}

// Portable code takes the base `Sandbox` type: only the methods every provider has.
async function greet(box: Sandbox): Promise<string> {
  await box.files.write("greeting.txt", `hello from ${box.provider}\n`);
  return (await box.run("cat greeting.txt")).stdout.trim();
}

await using box = await createSandbox(await loadProvider(process.env.SANDBOX_PROVIDER ?? "memory"));
console.log(await greet(box));
```

The dynamic `import()` per case means only the provider you pick needs its peer package installed. At runtime that holds as written. For the TypeScript compiler, the switch still reaches every listed adapter's declarations, and those reference their peer's types. Set `"skipLibCheck": true` in `tsconfig.json` (most templates already do), or install the peers you list as devDependencies, otherwise `tsc` reports TS2307 for the ones you left out. The repository's `examples/getting-started/src/multi-provider.ts` is the same program with every provider and an exhaustive switch.

## Check capabilities before optional calls

`pause`, `resume`, and `snapshot` exist only on providers that support them. With a concrete provider such as `createSandbox(boat())`, calling `box.snapshot()` is a compile error. A provider chosen at runtime has the wide `Provider` type, so those methods are optional and calling one directly is a compile error. `hasCapability` checks at runtime and narrows the type:

```ts
import { createSandbox, hasCapability } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";

declare const provider: Provider; // from loadProvider above

await using box = await createSandbox(provider);
if (hasCapability(box, "pause")) {
  await box.pause();
  await box.resume();
}
if (hasCapability(box, "snapshot")) {
  const { id } = await box.snapshot();
  console.log(`snapshot ${id}`);
}
```

Create options follow the same rule at runtime. `size`, `network`, `from`, `timeoutMs`, and `idleTimeoutMs` fail with `SandboxError` code `unsupported` on providers that cannot enforce them, instead of being ignored. Leave them out of code that must run everywhere.

## Clean up with `await using`

`await using box = await createSandbox(provider)` disposes the sandbox when the scope ends, including when your code throws:

- Without a `key`, it calls `box.destroy()` and the sandbox is deleted.
- With a `key` (`createSandbox(provider, { key: "user:123" })`), it calls `box.close()`. The sandbox keeps running, and the next `createSandbox` with that key reattaches to it.

You can also call `box.close()` or `box.destroy()` yourself. `reapSandboxes(provider, { olderThanMs: 60 * 60_000 })` deletes SDK-created sandboxes older than an hour, which catches anything a crashed process left behind. `await using` runs natively on Node.js 24 and Bun; on Node.js 22, compile with TypeScript or call `destroy()` in a `finally`.

## Known limitations

- No built-in provider supports `box.terminal()` yet.
- `timeoutMs` (hard lifetime) and `idleTimeoutMs` work only where the provider can enforce them; elsewhere `createSandbox` fails with `unsupported`. The [capability matrix](https://v2.sandbox-sdk.app/docs/reference/capabilities) lists which providers support each one.
- Some providers need preview ports declared up front: `createSandbox(provider, { ports: [3000] })`. Always send `preview.headers` with requests; several providers put the access token there. The matrix's `ports` and Preview URL rows say which providers need each.
- boxd routes one preview port at a time, the last one you requested.
- agentOS has no preview URLs and no background processes (`start` fails with `unsupported`).
- Memory runs a small fake shell (`echo`, `cat`, `printf`, `sleep`, `ls`, `printenv`) with no git and fake preview URLs. Use it for tests, not real workloads.
- Local pulls `node:22-bookworm` on first use.
- Live smoke on 2026-10-29 (create, `run`, file round-trip, streamed run, preview URL, destroy) passed on memory, local Docker, agentOS, E2B, Daytona, Vercel, Upstash Box, Boat, Tenki, boxd, Freestyle, Superserve and Sandboxer, with 0 sandboxes left afterwards. Railway was not run because we have no Railway credentials; its adapter passes the unit and contract tests but has not been checked live on this build. Superserve's default `superserve/node-22` template has no python3, so `run` fails with `unsupported` until you pass a template with python3 or set `installPython`.

## Report issues

Open an issue at https://github.com/opencoredev/sandbox-sdk/issues, or message Leo directly. Include:

- the SDK version (`1.0.0-beta.1`) and your runtime (Node.js or Bun version),
- the provider and the factory options you passed,
- for a `SandboxError`: `code`, `message`, `hint`, `provider`, and `sandboxId`,
- the smallest snippet that reproduces it.

The SDK redacts registered `secrets` from errors and output, but check your paste for API keys before you send it.

# AI app builder

A Next.js app where you describe a small web app and an agent builds it inside a sandbox. The chat on the left streams each tool call as it runs. Once the agent starts a server on port 3000, the right pane shows the live app in an iframe.

It uses the Vercel AI SDK with `sandboxTools` from `@opencoredev/sandbox-sdk/ai`. Each browser session gets one sandbox, keyed by a session cookie, so the agent keeps working on the same files across messages and after a server restart.

## Run it

From the repository root:

```sh
bun install
bun run --cwd packages/sdk build
cp examples/ai-app-builder/.env.example examples/ai-app-builder/.env.local
# add ANTHROPIC_API_KEY to .env.local
bun run --cwd examples/ai-app-builder dev
```

Open http://localhost:3000. The default provider is local Docker, so Docker Engine must be running. The first sandbox pulls `node:22-bookworm`.

To try it without a model or API key, set `AI_MODEL=scripted`. A fake model replays a fixed build: it writes a static app and a `node:http` server, starts it with `start_process`, and checks it with `curl`. The tools, sandbox and preview are all real.

## Environment variables

| Variable                                              | Default                     | Purpose                                                                        |
| ----------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| `SANDBOX_PROVIDER`                                    | `local`                     | `local` (Docker), `e2b`, `vercel`, or `daytona`                                |
| `AI_MODEL`                                            | `anthropic:claude-opus-5-5` | `<provider>:<model id>` for `anthropic`, `openai`, or `gateway`; or `scripted` |
| `ANTHROPIC_API_KEY`                                   |                             | Required for `anthropic:` models                                               |
| `OPENAI_API_KEY`                                      |                             | Required for `openai:` models                                                  |
| `AI_GATEWAY_API_KEY`                                  |                             | Required for `gateway:` models, e.g. `gateway:anthropic/claude-opus-5-5`       |
| `E2B_API_KEY`                                         |                             | Required for `e2b`                                                             |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` |                             | Required for `vercel` (or `VERCEL_OIDC_TOKEN`)                                 |
| `DAYTONA_API_KEY`                                     |                             | Required for `daytona`                                                         |

## How it fits together

- `app/api/chat/route.ts` reads the session cookie, gets the session's sandbox, and streams `buildApp()` to the browser with `toUIMessageStreamResponse()`.
- `lib/agent.ts` holds the one agent code path: instructions, `sandboxTools(box)`, and `streamText` with a 30-step limit.
- `lib/sandbox.ts` calls `createSandbox(provider, { key: "ai-app-builder:<session>", ports: [3000] })`. With a key, the SDK finds the existing sandbox instead of creating a second one.
- `app/preview/[[...path]]/route.ts` proxies `box.preview(3000)`. Provider access headers, such as Daytona's preview token, stay on the server, and a local Docker preview bound to `127.0.0.1` works from any device that can reach the Next server.
- `app/api/sandbox/route.ts` destroys the session's sandbox when you click **New sandbox**.

The preview iframe is sandboxed without `allow-same-origin`, so code the agent writes can't read the builder's cookies or storage. Generated apps that need `localStorage` won't have it here. To give them storage, serve previews from a separate origin (for example the provider's preview URL) and add `allow-same-origin` there.

## Check the sandbox side without a model

```sh
bun run --cwd examples/ai-app-builder dry-run "A tiny counter"
```

This runs the same `buildApp()` with the scripted model against `SANDBOX_PROVIDER`, fetches the preview, checks that it serves the page and its stylesheet, and destroys the sandbox. Set `KEEP=1` to leave the sandbox running.

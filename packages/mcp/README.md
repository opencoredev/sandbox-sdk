# @opencoredev/sandbox-mcp

An MCP server that gives any agent sandboxes, on every provider [Sandbox SDK](https://sandbox-sdk.app) supports. Create a sandbox, run commands, edit files, start a dev server and get its URL, then pause or destroy it.

## Add it to your client

```json
{
  "mcpServers": {
    "sandbox": {
      "command": "npx",
      "args": ["-y", "@opencoredev/sandbox-mcp"],
      "env": { "E2B_API_KEY": "..." }
    }
  }
}
```

In Claude Code:

```bash
claude mcp add sandbox -e E2B_API_KEY=... -- npx -y @opencoredev/sandbox-mcp
```

## Providers

The server offers every provider whose credentials are in its environment, then `local` (Docker on your machine, no key).

| Provider     | Environment                                                             |
| ------------ | ----------------------------------------------------------------------- |
| `local`      | None. Needs Docker                                                      |
| `e2b`        | `E2B_API_KEY`                                                           |
| `vercel`     | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`                   |
| `modal`      | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`                                  |
| `baseten`    | `BASETEN_API_KEY`                                                       |
| `instabox`   | `INSTABOX_API_KEY`                                                      |
| `daytona`    | `DAYTONA_API_KEY`, or `DAYTONA_JWT_TOKEN` and `DAYTONA_ORGANIZATION_ID` |
| `upstash`    | `UPSTASH_BOX_API_KEY`                                                   |
| `railway`    | `RAILWAY_API_TOKEN`, `RAILWAY_ENVIRONMENT_ID`                           |
| `sandboxer`  | `SANDBOXER_API_KEY`                                                     |
| `boat`       | `BOAT_API_KEY`                                                          |
| `luxor`      | `TENKI_API_KEY` or `TENKI_AUTH_TOKEN`                                   |
| `superserve` | `SUPERSERVE_API_KEY`, plus the setup below                              |
| `boxd`       | `BOXD_API_KEY`                                                          |
| `freestyle`  | `FREESTYLE_API_KEY`                                                     |

A provider is offered only when its whole row is set, so a stray `VERCEL_TOKEN` without its team and project does not push Docker out of the default spot. Vercel also accepts `VERCEL_OIDC_TOKEN` on its own.

Superserve's default template has no Python, which the adapter needs. Set `SUPERSERVE_TEMPLATE` to a template that has it, or `SUPERSERVE_INSTALL_PYTHON=1` to let the adapter install it on first use.

`SANDBOX_PROVIDERS=e2b,local` names the providers outright. `SANDBOX_PROVIDER=e2b` picks the default for calls that name none; without it, the first one is the default.

Vercel, Modal, Baseten, Upstash, Railway, Luxor and boxd run through the provider's own SDK. Install it next to this package; [Peer packages](https://sandbox-sdk.app/docs/getting-started/installation) lists each one.

## Tools

| Tool                                                                  | What it does                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `list_providers`                                                      | The configured providers and what each supports              |
| `create_sandbox`                                                      | Create a sandbox, or reattach to the one with the same `key` |
| `list_sandboxes`                                                      | Sandboxes on a provider, with their state                    |
| `pause_sandbox`, `resume_sandbox`                                     | Where the provider supports pause                            |
| `destroy_sandbox`                                                     | Delete a sandbox                                             |
| `run`, `read_file`, `write_file`, `edit_file`, `search`, `list_files` | Commands and files in a sandbox                              |
| `start_process`, `process_logs`, `stop_process`, `preview`            | Background processes and their URLs                          |

`create_sandbox` returns a reference such as `e2b:abc123`, and every other tool takes it as `sandbox`. The reference names the provider and the sandbox, so it stays valid when the server restarts.

The command and file tools are the SDK's [agent tools](https://sandbox-sdk.app/docs/reference/agent-tools): the same descriptions, limits, output format and secret redaction as the AI SDK, Mastra and OpenAI Agents integrations.

Sandboxes outlive the server. Nothing is destroyed until an agent calls `destroy_sandbox`, or the provider's lifetime or the `timeoutMinutes` passed at creation runs out.

## Use it as a library

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSandboxMcpServer } from "@opencoredev/sandbox-mcp";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

const server = createSandboxMcpServer({
  providers: new Map([["e2b", () => e2b()]]),
  tools: { beforeRun: (command) => !command.includes("rm -rf") },
});

await server.connect(new StdioServerTransport());
```

To expose one sandbox you already hold, use `sandboxMcpServer(box)` from `@opencoredev/sandbox-sdk/mcp` instead.

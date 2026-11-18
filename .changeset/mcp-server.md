---
"@opencoredev/sandbox-sdk": minor
"@opencoredev/sandbox-mcp": minor
---

Sandboxes over MCP. `@opencoredev/sandbox-sdk/mcp` adds `sandboxMcpServer(box)` and `registerSandboxTools(server, box)`, which serve the agent tools to any MCP client, with output as progress notifications and `isError` on a `FAILED` result. The new `@opencoredev/sandbox-mcp` package is a runnable server (`npx @opencoredev/sandbox-mcp`) that also creates, lists, pauses, resumes and destroys sandboxes on every configured provider. `/tools` now exports `toolDescriptions`.

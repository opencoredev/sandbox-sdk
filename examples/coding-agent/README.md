# Coding agent

A command-line agent that clones a Git repository into a sandbox, works on a task with AI SDK tools, and prints the diff of what it changed. Your machine never runs the agent's commands; the sandbox does.

```sh
bun start "Add a --version flag to the CLI" --repo https://github.com/you/project
```

The agent clones the repository with `box.git.clone` to `/workspace/repo`, runs an AI SDK `streamText` loop with `sandboxTools` rooted there, and prints each tool call as it happens. When the loop ends, it prints `box.files.changes()` since the clone: the added, modified and removed files and a unified patch. It does not commit or push.

## Run it

From the repository root:

```sh
bun install
bun run --cwd packages/sdk build
cd examples/coding-agent
export ANTHROPIC_API_KEY=...
bun start "<task>" --repo <git url>
```

The default provider is local Docker, so Docker Engine must be running. The first sandbox pulls `node:22-bookworm`.

| Flag              | Meaning                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `--repo <url>`    | Repository to clone. Required.                                                                                  |
| `--branch <name>` | Branch to check out.                                                                                            |
| `--keep <key>`    | Keep the sandbox under this key. Rerun with the same key to continue in the same sandbox; the clone is skipped. |
| `--dry-run`       | Replay a fixed tool script instead of calling a model. No API key needed.                                       |

Without `--keep`, the sandbox is destroyed when the command exits. With it, the sandbox keeps running until you destroy it, for example with `docker rm -f` on local Docker or `reapSandboxes(provider, { labels: { example: "coding-agent" } })`.

## Environment variables

| Variable                                                                                  | Default                     | Purpose                                                                                                              |
| ----------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SANDBOX_PROVIDER`                                                                        | `local`                     | `local` (Docker), `e2b`, `vercel`, or `daytona`                                                                      |
| `AI_MODEL`                                                                                | `anthropic:claude-opus-5-5` | `<provider>:<model id>` for `anthropic`, `openai`, or `gateway`                                                      |
| `ANTHROPIC_API_KEY`                                                                       |                             | Required for `anthropic:` models                                                                                     |
| `OPENAI_API_KEY`                                                                          |                             | Required for `openai:` models                                                                                        |
| `AI_GATEWAY_API_KEY`                                                                      |                             | Required for `gateway:` models, e.g. `gateway:anthropic/claude-opus-5-5`                                             |
| `GITHUB_TOKEN`                                                                            |                             | Token for private repositories. It reaches git through a credential helper, never argv, and is redacted from output. |
| `E2B_API_KEY`, `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`, `DAYTONA_API_KEY` |                             | Credentials for the cloud providers                                                                                  |

## Try it without a model

```sh
bun run dry-run --repo https://github.com/octocat/Hello-World
```

A fake model makes three decisions: list the repository, write `AGENT_NOTES.md`, and run `git status`. The clone, the tools, the sandbox and the diff are real, so this checks everything except the model.

# Agent instructions

## 1.0 rewrite in progress

Sandbox SDK 1.0 is being rewritten from scratch on `leoplayz317/sbx-23-rewrite-sandbox-sdk-10-from-scratch`, which branches from `v2`. The full design lives in `docs/spec.md`. Read it before changing anything, and treat it as the source of truth.

- Track work in the Linear `SBX` team (marketing in `SBXM`), under the "Sandbox SDK 1.0 rewrite" project. The umbrella issue is SBX-23.
- Layout:
  - `packages/sdk` is the library.
  - `apps/web` is the landing page.
  - `apps/docs` is the Blume docs, served at `/docs`.
  - `bench/` is the benchmark harness.
  - `examples/` holds the examples.
- Load `~/.agents/skills/typescript-best-practices/SKILL.md` before writing TypeScript.
- Tests run with a timeout and at most 4 workers. Never run unbounded suites.

## Checks

Run these from the repo root before you push:

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

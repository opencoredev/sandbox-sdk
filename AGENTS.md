# Agent instructions

## Project

Sandbox SDK is released as `@opencoredev/sandbox-sdk` 1.x from `main`. The design lives in `docs/spec.md`; read it before changing the core or an adapter's contract. The published user docs are `apps/docs/content`, which CI checks against the code, so update them in the same change as the behavior they describe.

- Layout:
  - `packages/sdk` is the library.
  - `apps/web` is the landing page.
  - `apps/docs` is the Blume docs, served at `/docs`.
  - `bench/` is the benchmark harness.
  - `examples/` holds the examples.
- Load `~/.agents/skills/typescript-best-practices/SKILL.md` before writing TypeScript.
- Tests run with a timeout and at most 4 workers. Never run unbounded suites.
- Every change to `packages/sdk` needs a changeset (`bun run changeset`; see `.changeset/README.md`).

## Checks

Run these from the repo root before you push:

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

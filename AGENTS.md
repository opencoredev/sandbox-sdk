# Agent instructions

## V2 is in progress

Sandbox SDK V2 is being built on the long-lived `v2` branch. It merges into `main` once, when V2 is released.

- Branch from `v2`, not `main`, and open pull requests against `v2`.
- Don't target `main` with V2 work. Only urgent fixes for current users go to `main`; merge `main` into `v2` afterwards so the branches don't drift.
- Track work in the Linear `SBX` team (marketing in `SBXM`), under the "Sandbox SDK V2" project.

## Checks

CI runs these from the repo root. Run them before you push:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
```

Don't run `bun run build` in `packages/sdk` while the docs dev server is running; it clears `dist`, which the docs site imports.

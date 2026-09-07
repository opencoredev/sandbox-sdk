# Ship `@opencoredev/sandbox-sdk@1.0.0`

Do not close LEO-104 until npm `1.0.0` and a GitHub Release exist. This session must not publish, push, or create that Release.

## Ready

- Package build, lint, typecheck, and unit tests
- Old-import type checks
- Docs static build
- Compiled complete docs snippets
- `createSandbox({ provider })` kept; no `/compat` package
- Landing switchboard + screenshot
- Every shipped adapter has `liveTest: null` and docs repeat it
- Cloudflare adapter is Worker-binding only and experimental

## Verified

- SDK lint, typecheck, and build pass.
- Full suite: 113 pass, 20 skip, 0 fail across 48 files.
- `bun pm pack --dry-run`: 79 files, 0.60 MB.
- Final static docs build passes.
- `git diff --check` and the static honesty scan pass.
- Independent xAI review loop: needs cleanup → mostly clean → clean.

## Decided

- No separate 0.2.1. Honesty ships in this cut (LEO-100 canceled).
- CreateOS stays out of 1.0.0 (LEO-109 recorded; PR 9 close is Leo's).
- Experimental Cloudflare stays in the cut with `liveTest: null`.
- `package.json` is `1.0.0` on disk. npm still has 0.2.0.

## Blocked on Leo

- Commit the tree
- `npm publish` / trusted publishing
- GitHub Release object
- Optional: dated live rows instead of null
- Close CreateOS PR 9

## Out of 1.0.0

- Modal adapter (no confirmed TS files+exec API)
- Blaxel from closed PR 5
- Launch video
- Invented live-test dates

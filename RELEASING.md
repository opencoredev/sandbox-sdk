# Releasing Sandbox SDK

`@opencoredev/sandbox-sdk` in `packages/sdk` is the only published package. Releases go out from GitHub Actions through [changesets](https://github.com/changesets/changesets) and npm trusted publishing. Nobody publishes from a laptop, and no npm token is stored anywhere.

## Add a changeset

Every PR that changes the package adds a changeset, and CI fails without one:

```bash
bun run changeset
```

Pick the bump (`patch`, `minor` or `major`) and write one line for the changelog. A PR with no user-facing change can add `bun run changeset --empty` instead.

## How a release goes out

1. A PR with a changeset merges into `main`.
2. The Release workflow (`.github/workflows/release.yml`) opens or updates a PR titled "chore: version packages". It bumps `packages/sdk/package.json` and writes `packages/sdk/CHANGELOG.md` from the pending changesets.
3. Merging that PR runs the workflow again. `changeset publish` publishes the new version to npm with provenance, then the workflow pushes the git tag and creates the GitHub release.

`changeset publish` skips a version that is already on npm, so rerunning the workflow is safe.

## Switches and setup

- **Release switch:** the workflow only runs when the repository variable `SANDBOX_SDK_RELEASE_ENABLED` is `true` (Settings → Secrets and variables → Actions → Variables). Unset or `false`, merging to `main` neither opens a version PR nor publishes.
- **Trusted publisher:** npm trusts `opencoredev/sandbox-sdk` with workflow `release.yml` and no environment, under the package's settings on npmjs.com. Renaming the workflow file breaks publishing until the trusted publisher is updated to match.
- **npm version:** trusted publishing needs npm 11.5.1 or later. The workflow installs npm 11 before publishing.

## Before merging the version PR

The workflow builds the package, and `npm publish` runs `prepack`, which rebuilds `dist` from source, so the artifact is never stale. CI on `main` has already run lint, typecheck, tests, the bundle smoke and the packed-tarball consumer smoke. To check the tarball by hand:

```bash
cd packages/sdk
npm pack --dry-run
```

It should list only `dist`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json`.

After a release, `npm view @opencoredev/sandbox-sdk dist-tags` shows the new version on `latest`.

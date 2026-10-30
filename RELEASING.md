# Releasing Sandbox SDK

Releases are published manually. The only publishable workspace package is
`@opencoredev/sandbox-sdk` in `packages/sdk`.

## Versions and dist-tags

1.0 ships as prereleases first: `1.0.0-beta.0`, `1.0.0-beta.1`, and so on, while
the API can still change. Prereleases go to the `next` dist-tag, so
`npm install @opencoredev/sandbox-sdk` keeps resolving to 0.2.0 on `latest`.
`packages/sdk/package.json` sets `publishConfig.tag` to `next`, so a plain
`npm publish` cannot move `latest` by accident.

When the API is frozen, publish `1.0.0-rc.0`. For the final `1.0.0`, remove
`publishConfig.tag` (or set it to `latest`) in the same commit as the version
bump.

## Publish a release

1. Set the version in `packages/sdk/package.json` and add release notes to
   `packages/sdk/CHANGELOG.md`.
2. Install and verify from the repository root:

   ```bash
   bun install --frozen-lockfile
   bun run lint
   bun run typecheck
   bun run test
   bun run build
   ```

3. Commit and push the version and changelog to `main`.

4. Preview the npm artifact from the pushed commit. Check that the file list
   holds `dist`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `package.json`
   and nothing else. `npm pack` and `npm publish` run the `prepack` script,
   which rebuilds `dist` from source first, so the artifact is never stale:

   ```bash
   cd packages/sdk
   npm pack --dry-run
   npm publish --dry-run
   ```

5. Authenticate with the OpenCore npm account and publish:

   ```bash
   npm login
   npm publish
   ```

   `publishConfig` supplies `--access public` and the dist-tag. Check the result
   with `npm view @opencoredev/sandbox-sdk dist-tags`.

6. Tag the published commit and push the tag:

   ```bash
   git tag v1.0.0-beta.0
   git push origin v1.0.0-beta.0
   ```

Replace `v1.0.0-beta.0` with the version being published. Never commit npm
credentials or environment files.

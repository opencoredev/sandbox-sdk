# Releasing Sandbox SDK

Releases are published manually. The only publishable workspace package is
`@opencoredev/sandbox-sdk`.

## Publish a release

1. Update the version in `packages/sdk/package.json` and add the release notes to
   `packages/sdk/CHANGELOG.md`.
2. Install and verify the release candidate:

   ```bash
   bun install --frozen-lockfile
   bun run lint
   bun run typecheck
   bun run test
   bun run build
   ```

3. Commit and push the version and changelog to `main`.

4. Preview the npm artifact from the pushed commit:

   ```bash
   cd packages/sdk
   npm pack --dry-run
   ```

5. Authenticate with the OpenCore npm account and publish publicly:

   ```bash
   npm login
   npm publish --access public
   ```

6. Tag the published commit and push the tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

Replace `v0.1.0` with the version being published. Never commit npm credentials or environment
files.

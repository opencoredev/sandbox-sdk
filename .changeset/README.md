# Changesets

Every PR that changes `@opencoredev/sandbox-sdk` adds a changeset: run `bun run changeset`, pick the bump, and write one line for the changelog. A PR with no user-facing change can add an empty one with `bun run changeset --empty`.

The repo is in prerelease mode (`pre.json`), so versions come out as `1.0.0-beta.N` and publish under the `next` npm tag. See `RELEASING.md` for how releases go out.

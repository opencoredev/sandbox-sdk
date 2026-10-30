# Changesets

Every PR that changes `@opencoredev/sandbox-sdk` adds a changeset: run `bun run changeset`, pick the bump, and write one line for the changelog. CI fails a PR that changes the package without one. A PR with no user-facing change can add an empty changeset with `bun run changeset --empty`.

See `RELEASING.md` for how a changeset becomes a release.

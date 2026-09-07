# Adapter authoring kit

A shipped adapter needs all of these. An adapter-only PR is incomplete.

1. `src/providers/<id>/index.ts` — factory returns `defineAdapter(...)`.
2. Capabilities in `src/providers/capabilities.ts`.
3. Metadata row in `src/metadata.ts` with `liveTest: null` until a dated run exists.
4. Package export in `package.json` and `tsdown.config.ts`.
5. Example in `examples/<id>.ts`.
6. Unit test in `tests/providers/<id>.test.ts`.
7. Live stub in `tests/live/<id>.test.ts` gated on credentials.
8. Docs page in `apps/fumadocs/content/docs/providers/<id>.mdx` using `_template/docs.mdx`.

Copy `index.ts` and replace `example` with your id. Unsupported methods must throw `unsupported`, not pretend.

Run required conformance with `posixConformanceCommands()` from `@opencoredev/sandbox-sdk/testing` when the guest is a POSIX shell.

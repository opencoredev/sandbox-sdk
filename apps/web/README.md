# Sandbox SDK website

The landing page at [sandbox-sdk.app](https://sandbox-sdk.app), built with Next.js and statically
exported. The docs are a separate Blume app in `apps/docs`, served under `/docs`.

From the repository root:

```bash
bun install
bun run dev
```

Links to `/docs` 404 in development unless you point this app at the docs dev server:

```bash
DOCS_ORIGIN=http://localhost:4000 bun run dev
```

`next.config.mjs` then proxies `/docs` and `/docs/*` to that origin. In production the host routes
`/docs` to the docs app, so the rewrite only runs in development.

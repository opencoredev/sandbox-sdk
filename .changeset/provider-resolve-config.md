---
"@opencoredev/sandbox-sdk": minor
---

Add `resolveConfig(options?)` to the Baseten, Beam, Boat, boxd, Daytona, E2B, Freestyle, Instabox, Superserve, Tenki, Upstash and Vercel entry points. It returns the endpoint, credentials and scope the adapter already uses for those options and the current environment, and throws `auth` when credentials are missing, as the adapter does. Use it to point your own client at the same account, region, team and project, for example `Sandbox.get({ ...resolveConfig(), name })` with `@vercel/sandbox`. The result holds credentials: never log it.

Nothing else changes: every adapter sends the same requests, and its `native.sdk()` clients get the same options, as before. E2B's native init types now list `apiUrl`, which the `e2b` package accepts.

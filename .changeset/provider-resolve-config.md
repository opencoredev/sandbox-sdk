---
"@opencoredev/sandbox-sdk": minor
---

Add `resolveConfig(options?)` to the Baseten, Boat, boxd, Daytona, E2B, Freestyle, Instabox, Superserve, Tenki, Upstash and Vercel entry points. It returns the endpoint, credentials and scope the adapter itself uses for those options and the current environment, in the shape the provider's own SDK takes, and throws `auth` when credentials are missing, as the adapter does. Each adapter now builds its requests from the same function, so a client you build from it reaches the same account, region, team and project as the adapter: for example `Sandbox.get({ ...resolveConfig(), name })` with `@vercel/sandbox`, or `new Daytona(resolveConfig())`.

The clients `native.sdk()` builds now get the same values. Daytona and Superserve pass the base URL without trailing slashes (a trailing slash in `DAYTONA_API_URL` or `SUPERSERVE_BASE_URL` made those clients request `//` paths), and E2B passes its API URL explicitly, so `E2B_DEBUG` no longer points the `e2b` package at localhost while the adapter uses the configured domain. Upstash drops every trailing slash from its base URL, not only the last, and hands the resolved base URL to `@upstash/box`.

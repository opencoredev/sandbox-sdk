# Briq provider

Install `@briq-cloud/sdk` and import `briq` from `@opencoredev/sandbox-sdk/briq`. Pass `apiKey`, or set `BRIQ_API_KEY`. The SDK loads on first use, so the factory never throws for a missing key; the first call does.

`briq({ apiKey, baseUrl, stack, fetch })` accepts an API origin, a stack name (default `opencore`), and a `fetch` implementation. `baseUrl` falls back to `BRIQ_API_URL`, then `https://api.briq.cloud`. The image is fixed to `ghcr.io/briq-cloud/sandbox:latest`; an `image` option fails with `unsupported`.

The provider declares no optional capability. `size`, `network` other than unrestricted access, `idleTimeoutMs`, `timeoutMs`, and `from` fail with `unsupported` before any request. Keys are best-effort. The subpath exports `BriqOptions`, `BriqNative`, and `BriqProvider`.

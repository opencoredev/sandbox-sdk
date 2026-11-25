# Luxor provider

Install `@luxorai/sandbox` and import `tenki` from `@opencoredev/sandbox-sdk/tenki`. Pass `apiKey`, or set `TENKI_AUTH_TOKEN` or `TENKI_API_KEY` (in that fallback order). The SDK loads on first use.

`tenki({ apiKey, baseUrl, image, requestTimeoutMs, waitTimeoutMs })` accepts an endpoint, base image, and request budgets. `baseUrl` falls back to `LUXOR_API_ENDPOINT`, then `LUXOR_API_URL`, `TENKI_API_ENDPOINT` and `TENKI_API_URL`, then `https://api.luxor.ai`. Omit `image` to use the service default. Control requests default to 30 seconds. Readiness defaults to 180 seconds, or 300 seconds for snapshot completion; `waitTimeoutMs` accepts 1–900000 ms. Resume requests have a separate `resumeTimeoutMs`, defaulting to 180 seconds.

`authToken` remains a deprecated alias for `apiKey` until 2.0.0. If both are set, `apiKey` wins. The subpath exports `TenkiProvider`.

# boxd provider

Install `@boxd-sh/sdk` and import `boxd` from `@opencoredev/sandbox-sdk/boxd`. Set `BOXD_API_KEY` or pass `apiKey`. The SDK loads on first use.

`boxd({ apiKey, baseUrl, image, requestTimeoutMs })` accepts an endpoint, image, and request deadline. `baseUrl` falls back to `BOXD_BASE_URL`, then `BOXD_API_URL`, then `https://boxd.sh:9443`. Omit `image` to use the service default. Control requests, including create, default to 30 seconds; readiness defaults to 90 seconds. Images need Python 3, Git, GNU tar, and `nohup`.

`baseURL` remains a deprecated alias for `baseUrl` until 1.0.0. If both are set, `baseUrl` wins. The subpath exports `BoxdProvider`.

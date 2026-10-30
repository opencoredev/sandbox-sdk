# Sandboxer provider

Import `sandboxer` from `@opencoredev/sandbox-sdk/sandboxer`; no other package is needed, because the adapter calls Sandboxer's API over HTTP. Set `SANDBOXER_API_KEY` or pass `apiKey`. A missing key fails with `auth` on the first operation.

`sandboxer({ apiKey, baseUrl, machine, region, requestTimeoutMs })` talks to Sandboxer's Boat-compatible API. `baseUrl` defaults to `https://sandboxer.com/api/v1`. `machine` defaults to Sandboxer's `default` size (4 vCPU and 8 GiB); a per-create `size` takes precedence. Control requests and lifecycle polls default to a 90-second deadline.

`region` picks `us-east` (Ashburn, Virginia) or `eu-central` (Helsinki). It falls back to `SANDBOXER_REGION`; without either, Sandboxer places each sandbox in the region nearest the caller. A restore from a snapshot must use the snapshot's region. `box.native.region` and `box.native.regionSource` (`requested`, `nearest`, `default`, or `source`) report the placement.

The provider supports `pause`, `snapshot`, and `size`. `createSandbox` makes two control-plane calls (create and a metadata rename) and defers workspace setup to the first command or file operation. Previews return the URL without `_token` plus a `Cookie: __sbx_auth=...` header. The subpath exports `SandboxerProvider`.

See the [Sandboxer provider guide](https://sandbox-sdk.app/docs/providers/sandboxer) for sizes, trial limits, and snapshot cleanup.

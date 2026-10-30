# Boat provider

Install `@boatdev/sdk` and import `boat` from `@opencoredev/sandbox-sdk/boat`. Set `BOAT_API_KEY` or pass `apiKey`. The SDK loads on first use.

`boat({ apiKey, baseUrl, machine, requestTimeoutMs })` accepts an endpoint and native machine size. `baseUrl` falls back to `BOAT_API_BASE`, then `https://boat.dev/api/v1`. `machine` defaults to Boat's `default` size (4 CPUs and 8 GB RAM). A per-create `size` takes precedence. Control requests default to a 90-second deadline.

`apiUrl` and `type` remain deprecated aliases for `baseUrl` and `machine` until 1.0.0. If both names are set, the new name wins. The subpath exports `BoatProvider`, whose native object contains the Boat client and sandbox.

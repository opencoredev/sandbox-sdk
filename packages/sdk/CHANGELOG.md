## Unreleased

- Add the Tenki provider adapter with files, streamed processes with stdin, public
  preview URLs, disk-plus-memory snapshots, pause/resume, package export, live-test entry point,
  and provider documentation.

## @opencoredev/sandbox-sdk@0.2.0

- Add Ascii Box and Railway Sandbox provider adapters, package exports, capabilities, examples,
  live-test entry points, and provider documentation.
- Normalize HTTP response status codes from provider SDK errors.

## @opencoredev/sandbox-sdk@0.1.1

- Add `Symbol.asyncDispose` to `Sandbox` so `await using` provides automatic cleanup.

## @opencoredev/sandbox-sdk@0.1.0

### Initial release

- Run one TypeScript sandbox API across Local, E2B, Daytona, Vercel Sandbox, and Upstash Box.
- Use normalized files, commands, processes, ports, snapshots, and provider capabilities.
- Integrate sandbox sessions with AI SDK, Harness, Eve, and Mastra.

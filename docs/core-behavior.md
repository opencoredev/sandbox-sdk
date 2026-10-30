# Core behavior details

Edge-case behavior of commands, secrets, and background process logs that applies to every provider. Moved from the package README.

`@opencoredev/sandbox-sdk` 1.0 is ESM for Node 22+ and Bun 1.3+. The root exposes lifecycle functions, `SandboxError`, and the public handle types. Provider adapters import the primitive contract from `/provider`; `/memory` supplies an offline fake; `/testing` registers the shared Vitest suite.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

await using box = await createSandbox(memory());
await box.files.write("hello.txt", "hello\n");
const result = await box.$`cat ${"hello.txt"}`;
console.log(result.stdout);
```

The result is `hello` followed by a newline. Commands are lazy: awaiting or iterating a `RunHandle` starts execution, after its chained options have been applied. Iteration streams live output; awaiting returns the capped result. Stream failures throw `SandboxError`. Nonzero exits, timeouts, and aborts return results.

## Timeouts, secrets, and process logs

A command timeout or abort returns a `timedOut` result only after the adapter confirms termination. Cancellation or remote cleanup failures throw `SandboxError`, including `outcome_unknown` when termination cannot be confirmed.

Secret filtering protects each command stream and the interleaved `output` and async chunks, including secrets split between stdout and stderr.

Process line cursors include unfinished fragments from both streams. Pass the opaque string unchanged when resuming, including from another client. Malformed serialized cursors fail with `invalid_argument`.

Durable process logs preserve UTF-8 code points across shell-reader blocks. The fallback requires the standard Linux `dd`, `tail`, and `od` utilities.

Process log pages use bounded remote ranges under the rotation lock. `maxBytes` is an upper bound; a page may stop at 64 KiB even when a larger budget is requested. Follow `nextCursor` while `truncated` is true. Reads include bounded framing lookaround and never download the entire 10 MiB log. Memory providers may implement the optional `files.readRange` primitive.

Readiness failures include the retained last 50 log lines, even when subsequent cursor pages are empty. The retained diagnostic tail is capped at 256 KiB for unusually long lines.

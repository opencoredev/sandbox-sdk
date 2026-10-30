# Agent tools: detailed behavior

Reference for `/ai`, `/mastra`, `/openai`, and `/tools`. Moved from the package README.

Install the framework you use and `zod`. Import its adapter, then pass the tools to your agent:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { sandboxTools } from "@opencoredev/sandbox-sdk/ai";

await using box = await createSandbox(memory());
const tools = sandboxTools(box);
```

`/ai` returns an AI SDK tool map; `/mastra` returns a Mastra tool map; `/openai` returns an OpenAI Agents tool array. The adapters require AI SDK 7, Mastra 1.78, or OpenAI Agents 0.20 respectively, and Zod 4.6. They are optional peers and never load through the SDK root. `/tools` exposes `createSandboxTools`, `toolSchemas` (Zod schemas, convertible with `z.toJSONSchema`), and the shared option and event types for other integrations.

The default tools are `run`, `read_file`, `write_file`, `edit_file`, `start_process`, `process_logs`, and `stop_process`. Use `allow` to opt into `search`, `list_files`, `changes`, or `preview`; `deny` takes precedence. Parameters are flat and validated. `read_file` uses zero-based line offsets, returns numbered lines and a SHA-256, and reports `nextOffset` for pagination. Binary files return metadata. Edits require exactly one literal match; they do not provide optimistic concurrency checks.

```ts
const tools = sandboxTools(box, {
  root: "/workspace/app",
  allow: ["run", "read_file", "edit_file", "start_process", "process_logs", "stop_process"],
  beforeRun: (command) => (command.includes("rm -rf") ? false : command),
  limits: { run: { timeoutMs: 30_000, maxOutputBytes: 16_384 } },
  onEvent: (event) => sendToUI(event),
});

function sendToUI(event: { text: string }) {
  process.stdout.write(event.text);
}
```

`beforeRun` returns `false` to deny, a string to rewrite, or `true` to allow. It also applies to `start_process`. The `root` confines file parameters and working directories and rejects symlink components. It is not an OS security boundary: shell commands retain the sandbox's privileges, can use absolute paths, and can change directories. Configure sandbox isolation and command policy for untrusted agents. File checks cannot prevent a concurrent process from changing a path after validation.

Each result starts with `OK` or `FAILED`, followed by `output:`. Nonzero exits and timeouts are results. Commands default to a 30-second timeout; caller timeouts cannot exceed the configured tool limit. Output defaults to a 16,384-byte budget, with head and tail retained and a cut marker. The minimum budget is 256 bytes. Per-tool limits also support `maxReadBytes` (default 1 MB for reads) and `maxMatches` (default 100 for search).

Truncated foreground output includes a generated name and `cursor=0` for `process_logs`. The replay window retains the last 1 MB of each of the eight most recent foreground runs or long-line reads per tool collection; expired bytes are labeled. Background logs read the SDK's durable process records, normalize and redact them before paging, and return tool-specific byte cursors. These cursors are not interchangeable with `box.process(name).logs()` cursors; restart at zero after log rotation. File pagination stops at line boundaries where possible. A single line larger than the output budget includes a `process_logs` replay name and cursor so the cut content remains readable. Search, listings, and change summaries are capped summaries; narrow the path or query when they are cut. `changes` compares file hashes within `root` against a snapshot taken when the tools are created.

`onEvent` receives redacted foreground chunks and requested log pages before model formatting. Framework cancellation signals stop foreground runs; returning an AI preliminary iterator aborts and awaits its command. AI SDK also receives those foreground chunks as preliminary results; its `toModelOutput` returns only the final compact result to the model. Consumers that fall behind AI preliminary output have a bounded 1 MB queue. Background startup waits for a supplied `port`; without a port it confirms launch only. A readiness timeout returns `ready=false` and leaves the process available for logs or stopping. Preview access headers stay server-side. Registered sandbox secrets are redacted from every model result, including file contents, errors, and preview URLs; raw `box.files.read` remains unchanged. Tools require handles created or connected by this SDK so their secret redactor is available.

Framework API references checked for these adapters: [AI SDK tool](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool), [Mastra createTool](https://mastra.ai/reference/tools/create-tool), and [OpenAI Agents tools](https://openai.github.io/openai-agents-js/guides/tools/).

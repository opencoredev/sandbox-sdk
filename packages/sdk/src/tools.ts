import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { Sandbox, OutputChunk } from "./types.js";
import { SandboxError, invalid } from "./errors.js";
import { BufferCap } from "./run.js";
import { readAtMost } from "./files.js";
import { isString } from "./shared/narrow.js";
import { redactToolText, toolOutputFilter } from "./tool-security.js";
import type { JsonValue } from "./shared/json.js";

const text = z.string();
const positive = z.number().int().positive();
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const port = positive.max(65535);

export const toolSchemas = {
  run: z.object({ command: text, cwd: text.optional(), timeoutMs: positive.optional() }).strict(),
  read_file: z
    .object({
      path: text,
      offset: z.number().int().nonnegative().optional(),
      limit: positive.optional(),
    })
    .strict(),
  write_file: z.object({ path: text, content: text }).strict(),
  edit_file: z.object({ path: text, find: text.min(1), replace: text }).strict(),
  start_process: z
    .object({ name, command: text, cwd: text.optional(), port: port.optional() })
    .strict(),
  process_logs: z.object({ name, cursor: text.optional() }).strict(),
  stop_process: z.object({ name }).strict(),
  search: z.object({ query: text, path: text.optional(), glob: text.optional() }).strict(),
  list_files: z.object({ path: text.optional(), glob: text.optional() }).strict(),
  changes: z.object({}).strict(),
  preview: z.object({ port, path: text.optional() }).strict(),
};

export type ToolName = keyof typeof toolSchemas;

export type ToolParameters = z.infer<(typeof toolSchemas)[ToolName]>;

export type ToolEvent = {
  tool: ToolName;
  kind: "output";
  stream: OutputChunk["stream"];
  text: string;
};

export interface ToolLimits {
  maxOutputBytes?: number;
  timeoutMs?: number;
  maxReadBytes?: number;
  maxMatches?: number;
}

export interface SandboxToolsOptions {
  /** Resolves file paths and cwd. Shell commands still have the sandbox's full privileges. */
  root?: string;
  allow?: readonly ToolName[];
  deny?: readonly ToolName[];
  beforeRun?: (command: string) => boolean | string | Promise<boolean | string>;
  limits?: Partial<Record<ToolName, ToolLimits>>;
  onEvent?: (event: ToolEvent) => void;
}

export interface ToolResult {
  text: string;
}

const descriptions: Record<ToolName, string> = {
  run: "Run a noninteractive command with a timeout. cwd and exports do not persist. Do not use for servers; use start_process, or file tools for reading and editing.",
  read_file:
    "Read numbered lines and a SHA-256; offset is a zero-based line index. Do not use for directory listings or binary contents.",
  write_file:
    "Create or replace a UTF-8 file. Do not use for a small change to an existing file; use edit_file.",
  edit_file:
    "Replace exactly one literal match. Do not use ambiguous snippets; include surrounding lines when a match is repeated.",
  start_process:
    "Start a named background process; with port, wait for readiness and return its URL. Do not use for short commands; use run.",
  process_logs:
    "Read a page of a named process's logs; pass the returned cursor for the next page. Do not restart a process to retrieve output.",
  stop_process:
    "Stop a named background process. Do not use to destroy the sandbox or stop unrelated processes.",
  search:
    "Find literal text in files under a path. Do not use for regular expressions; use run with rg instead.",
  list_files: "List files recursively under a path. Do not use to read file contents.",
  changes:
    "Show added, modified and removed files since these tools were created. Do not use for Git history.",
  preview:
    "Get the preview URL for a port. Do not use to start a server; use start_process first. Access headers stay server-side.",
};

const defaultNames: ToolName[] = [
  "run",
  "read_file",
  "write_file",
  "edit_file",
  "start_process",
  "process_logs",
  "stop_process",
];

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function createSandboxTools(box: Sandbox, options: SandboxToolsOptions = {}) {
  // Fail closed for foreign handles rather than silently returning unredacted file data.
  redactToolText(box, "");
  const root = posix.resolve("/workspace", options.root ?? ".");
  const selected = new Set(options.allow ?? defaultNames);

  for (const tool of options.deny ?? []) selected.delete(tool);

  function pathOf(path = ".") {
    const resolved = posix.resolve(root, path);

    if (resolved !== root && !resolved.startsWith(root === "/" ? "/" : `${root}/`))
      invalid("Path escapes tool root. Use a path inside the configured root");

    return resolved;
  }

  async function safePath(path = ".") {
    const resolved = pathOf(path);
    // Reject symlink components, including ancestors of the configured root.
    let current = "/";

    for (const part of resolved.split("/").filter(Boolean)) {
      current = posix.join(current, part);

      try {
        if ((await box.files.stat(current)).type === "symlink")
          invalid("Symlink path rejected. It may escape tool root. Use a regular path");
      } catch (error) {
        if (!(error instanceof SandboxError && error.code === "file_not_found")) throw error;
      }
    }

    return resolved;
  }

  async function commandOf(command: string) {
    const decision = await options.beforeRun?.(command);

    if (decision === false)
      invalid(
        "Command denied by beforeRun. Application policy refused execution. Choose an allowed command",
      );

    return isString(decision) ? decision : command;
  }

  const clean = (text: string) => redactToolText(box, text);
  // Foreground output has a bounded replay window; background logs remain SDK-owned.
  const runLogs = new Map<string, { buffer: Buffer; base: number; total: number }>();

  function remember(name: string, chunk: string) {
    const previous = runLogs.get(name) ?? { buffer: Buffer.alloc(0), base: 0, total: 0 };
    const data = Buffer.from(clean(chunk));
    const buffer = Buffer.concat([previous.buffer, data]);
    const total = previous.total + data.length;
    const retained = buffer.subarray(-1_048_576);
    runLogs.set(name, { buffer: retained, base: total - retained.length, total });

    while (runLogs.size > 8) {
      const oldest = runLogs.keys().next().value;

      if (oldest) runLogs.delete(oldest);
    }
  }

  async function snapshot() {
    const result = new Map<string, string>();
    const path = await safePath();

    if (!(await box.files.exists(path))) return result;

    for (const file of await box.files.list(path, { recursive: true }))
      if (file.type === "file")
        result.set(
          file.path,
          hash(await box.files.read(await safePath(file.path), { as: "bytes" })),
        );

    return result;
  }

  const baseline = selected.has("changes")
    ? snapshot().then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
    : undefined;

  function define<K extends ToolName>(tool: K) {
    const schema = toolSchemas[tool];
    const limits: ToolLimits = options.limits?.[tool] ?? {};
    const maxOutputBytes = limits.maxOutputBytes ?? 16_384;
    const timeoutMs = limits.timeoutMs ?? 30_000;

    if (
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 256 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    )
      invalid("Tool limits must have maxOutputBytes >= 256 and timeoutMs > 0");

    for (const value of [limits.maxReadBytes, limits.maxMatches])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        invalid("maxReadBytes and maxMatches must be positive integers");

    return {
      name: tool,
      description: descriptions[tool],
      inputSchema: schema,
      async execute(
        input: JsonValue,
        emit?: (event: ToolEvent) => void,
        signal?: AbortSignal,
      ): Promise<ToolResult> {
        const started = Date.now();
        let eventFailed = false;

        function notify(event: ToolEvent) {
          // A broken UI subscription must not abandon a running foreground command.
          try {
            options.onEvent?.(event);
          } catch {
            eventFailed = true;
          }

          try {
            emit?.(event);
          } catch {
            eventFailed = true;
          }
        }

        function result(ok: boolean, body: string, detail = "", cwd?: string, metadata = "") {
          const rawHeader = clean(
            `${ok ? "OK" : "FAILED"}${detail ? ` ${detail}` : ""} ${((Date.now() - started) / 1000).toFixed(1)}s${cwd ? ` cwd=${cwd}` : ""}`,
          );

          const headerCap = new BufferCap(Math.floor(maxOutputBytes / 4));
          headerCap.add(rawHeader);
          const header = headerCap.text();

          const cap = new BufferCap(
            Math.max(
              1,
              maxOutputBytes - Buffer.byteLength(header) - Buffer.byteLength(metadata) - 100,
            ),
          );

          cap.add(
            clean(
              body +
                (eventFailed
                  ? "\nUI streaming callback failed. Execution was allowed to finish. Fix onEvent before reconnecting the UI."
                  : ""),
            ),
          );

          return { text: clean(`${header}\noutput:\n${metadata}${cap.text()}`) };
        }

        try {
          // Discriminated parsing keeps each tool's parameters tied to its schema.
          const parsed = toolInput.parse({ tool, input });

          if (baseline) {
            const initial = await baseline;

            if ("error" in initial && parsed.tool === "changes") throw initial.error;
          }

          if (signal?.aborted)
            invalid(
              "Tool cancelled. The calling agent aborted execution. Retry only if still needed",
            );

          switch (parsed.tool) {
            case "run": {
              const p = parsed.input;
              const cwd = await safePath(p.cwd);

              const handle = box.run(await commandOf(p.command), {
                cwd,
                timeoutMs: Math.min(p.timeoutMs ?? timeoutMs, timeoutMs),
                maxOutputBytes,
                signal,
              });

              const cap = new BufferCap(Math.max(1, maxOutputBytes - 512));
              const logName = `run_${crypto.randomUUID().replaceAll("-", "")}`;
              remember(logName, "");

              const filter = toolOutputFilter(box, (chunk) => {
                cap.add(chunk.text);
                remember(logName, chunk.text);

                const event: ToolEvent = {
                  tool,
                  kind: "output",
                  stream: chunk.stream,
                  text: clean(chunk.text),
                };

                notify(event);
              });

              try {
                for await (const chunk of handle) filter.push(chunk);
              } finally {
                filter.flush();
              }

              const run = await handle;

              const output = cap
                .text()
                .replace(/\[(\d+) bytes cut\]/, "[$1 bytes cut, use process_logs]");

              return result(
                run.ok,
                `${output}${run.timedOut ? (signal?.aborted ? "\nAborted. The calling agent cancelled execution and the command was terminated. Retry only if still needed." : "\nTimed out. Command exceeded its limit and was terminated. Increase the configured timeout or use start_process for servers.") : ""}${!run.ok && !run.timedOut ? `\nCommand exited with status ${run.exitCode}. Inspect the output and correct the command before retrying.` : ""}`,
                `exit=${run.exitCode}`,
                cwd,
                cap.truncated ? `name=${logName} cursor=0 use=process_logs\n` : "",
              );
            }

            case "read_file": {
              const p = parsed.input;
              const path = await safePath(p.path);
              const max = limits.maxReadBytes ?? 1_048_576;
              const size = (await box.files.stat(path)).size;

              // Checked before the download, and the read stops one byte past the limit where the
              // adapter allows, so an oversized file never costs its full transfer.
              if (size > max)
                return result(
                  false,
                  `File is ${size} bytes, above maxReadBytes=${max}. Raise read_file's maxReadBytes or use run to extract a smaller file.`,
                );
              const bytes = await readAtMost(box.files, path, max);

              if (bytes.length > max)
                return result(
                  false,
                  `File grew above maxReadBytes=${max} while being read. Raise read_file's maxReadBytes or use run to extract a smaller file.`,
                );
              const sha = hash(bytes);
              let content: string;

              try {
                content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

                if (content.includes("\0")) throw new Error("binary");
              } catch {
                return result(
                  true,
                  `binary file; size=${bytes.length} bytes; sha=${sha}. Use download outside the agent tools to retrieve bytes.`,
                );
              }

              const lines = clean(content).split("\n"),
                offset = p.offset ?? 0;

              // Stop at a line boundary so nextOffset can retrieve every omitted line.
              const chosen: string[] = [];
              let count = 0;

              for (const [index, line] of lines
                .slice(offset, offset + (p.limit ?? 200))
                .entries()) {
                const numbered = `${offset + index + 1}: ${line}`;

                if (chosen.length && count + Buffer.byteLength(numbered) > maxOutputBytes - 600)
                  break;
                chosen.push(numbered);
                count += Buffer.byteLength(numbered) + 1;
              }

              const next = offset + chosen.length;
              let replay = "";

              if (count > maxOutputBytes - 600) {
                const name = `read_${crypto.randomUUID().replaceAll("-", "")}`;
                remember(name, chosen.join("\n"));
                replay = `name=${name} cursor=0 use=process_logs\n`;
              }

              return result(
                true,
                `${chosen.join("\n")}\n${next < lines.length ? "[more lines; use read_file with nextOffset as offset]" : ""}`,
                "",
                undefined,
                `sha=${sha} lines=${lines.length} nextOffset=${next < lines.length ? next : "end"}\n${replay}`,
              );
            }

            case "write_file": {
              const p = parsed.input;
              await box.files.write(await safePath(p.path), p.content);

              return result(true, "File written.");
            }

            case "edit_file": {
              const p = parsed.input;
              await box.files.edit(await safePath(p.path), { find: p.find, replace: p.replace });

              return result(true, "One exact match replaced.");
            }

            case "start_process": {
              const p = parsed.input;
              let proc;

              try {
                proc = await box.start(await commandOf(p.command), {
                  name: p.name,
                  cwd: await safePath(p.cwd),
                  ready: p.port ? { port: p.port } : undefined,
                  readyTimeoutMs: timeoutMs,
                });
              } catch (error) {
                if (!(error instanceof SandboxError && error.code === "timeout")) throw error;

                return result(
                  false,
                  `name=${p.name} ready=false cursor=0\n${error.message}\nUse process_logs to inspect startup or stop_process to terminate it.`,
                );
              }

              return result(
                proc.status !== "failed",
                `name=${p.name} ready=${proc.ready} status=${proc.status} url=${proc.url ?? "none"}\ncursor=0\nUse process_logs to inspect output.${!proc.ready ? "\nNot ready. The process may still be running. Use stop_process to stop it." : ""}`,
              );
            }

            case "process_logs": {
              const p = parsed.input;
              const replay = runLogs.get(p.name);

              if (replay) {
                const cursor = p.cursor === undefined ? replay.base : Number(p.cursor);

                if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > replay.total)
                  invalid(
                    "Invalid foreground log cursor. It is outside the retained output. Use cursor=0 to replay",
                  );
                let start = Math.max(cursor, replay.base);

                // Byte cursors always advance on UTF-8 boundaries, including an expired prefix.
                const continuation = (offset: number) => {
                  const byte = replay.buffer[offset - replay.base];

                  return byte !== undefined && (byte & 0xc0) === 0x80;
                };

                while (start < replay.total && continuation(start)) start++;
                let end = Math.min(replay.total, start + Math.max(64, maxOutputBytes - 512));

                while (end > start && end < replay.total && continuation(end)) end--;

                const text = replay.buffer
                  .subarray(start - replay.base, end - replay.base)
                  .toString();

                const event: ToolEvent = {
                  tool,
                  kind: "output",
                  stream: "stdout",
                  text: clean(text),
                };

                notify(event);

                return result(
                  true,
                  `cursor=${end} more=${end < replay.total}\n${cursor < replay.base ? `[${replay.base - cursor} bytes expired from replay window]\n` : ""}${text}${end < replay.total ? "\n[more output; use process_logs with cursor]" : ""}`,
                );
              }

              // Normalize retained durable output before paginating to avoid splitting secrets.
              const proc = box.process(p.name);
              const normalized = new BufferCap(10_485_760);
              const filter = toolOutputFilter(box, (chunk) => normalized.add(chunk.text));

              let after: string | undefined,
                more = false;

              for (let page = 0; page < 16; page++) {
                const raw = await proc.logs({ after, maxBytes: 1_048_576 });
                filter.push({ stream: "stdout", text: raw.text });
                more = raw.truncated && raw.nextCursor !== after;
                after = raw.nextCursor;

                if (!more) break;
              }

              // Withhold an ambiguous secret prefix at the live edge until more output arrives.
              if (proc.status === "exited" || proc.status === "failed") filter.flush();
              const buffer = Buffer.from(normalized.text());
              const cursor = p.cursor === undefined ? 0 : Number(p.cursor);

              if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > buffer.length)
                invalid(
                  "Log cursor is invalid or expired after rotation. The retained log view changed. Use cursor=0 to replay",
                );

              let start = cursor,
                end = Math.min(buffer.length, cursor + Math.max(32, maxOutputBytes - 512));

              const continuation = (at: number) => ((buffer[at] ?? 0) & 0xc0) === 0x80;

              while (start < buffer.length && continuation(start)) start++;

              while (end > start && end < buffer.length && continuation(end)) end--;
              const text = buffer.subarray(start, end).toString();
              notify({ tool, kind: "output", stream: "stdout", text });

              return result(
                true,
                `${text}${end < buffer.length || more ? "\n[more output; use process_logs with cursor]" : ""}`,
                "",
                undefined,
                `cursor=${end} more=${end < buffer.length || more}\n`,
              );
            }

            case "stop_process":
              await box.process(parsed.input.name).stop();

              return result(true, "Process stopped.");
            case "search": {
              const p = parsed.input;

              return result(
                true,
                JSON.stringify(
                  await box.files.search(p.query, {
                    path: await safePath(p.path),
                    glob: p.glob,
                    maxMatches: limits.maxMatches ?? 100,
                  }),
                ),
              );
            }

            case "list_files": {
              const p = parsed.input;

              return result(
                true,
                JSON.stringify(
                  await box.files.list(await safePath(p.path), { recursive: true, glob: p.glob }),
                ),
              );
            }

            case "changes": {
              const initial = await baseline;

              if (!initial || !("value" in initial)) invalid("Changes baseline unavailable");
              const now = await snapshot();

              return result(
                true,
                JSON.stringify({
                  added: [...now.keys()].filter((path) => !initial.value.has(path)),
                  modified: [...now.keys()].filter(
                    (path) => initial.value.has(path) && initial.value.get(path) !== now.get(path),
                  ),
                  removed: [...initial.value.keys()].filter((path) => !now.has(path)),
                }),
              );
            }

            case "preview": {
              const p = parsed.input;

              if (p.path && (!p.path.startsWith("/") || p.path.startsWith("//")))
                invalid(
                  "Preview path must be an absolute URL path. External URLs are not allowed. Use /path",
                );
              const preview = await box.preview(p.port, { path: p.path });

              return result(true, `url=${preview.url}`);
            }

            default: {
              const exhaustive: never = parsed;

              return exhaustive;
            }
          }
        } catch (error) {
          if (error instanceof SandboxError)
            return result(
              false,
              `${error.message}\ncode=${error.code} retryable=${error.retryable}\nNext: ${error.hint}`,
            );

          if (error instanceof z.ZodError)
            return result(
              false,
              "Invalid tool input. Parameters do not match the tool schema. Check the required fields and types, then retry.",
            );

          return result(
            false,
            "Tool failed. An unexpected execution or callback error occurred. Check server-side diagnostics and retry.",
          );
        }
      },
    };
  }

  return [...selected].map((tool) => define(tool));
}

const toolInput = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("run"), input: toolSchemas.run }),
  z.object({ tool: z.literal("read_file"), input: toolSchemas.read_file }),
  z.object({ tool: z.literal("write_file"), input: toolSchemas.write_file }),
  z.object({ tool: z.literal("edit_file"), input: toolSchemas.edit_file }),
  z.object({ tool: z.literal("start_process"), input: toolSchemas.start_process }),
  z.object({ tool: z.literal("process_logs"), input: toolSchemas.process_logs }),
  z.object({ tool: z.literal("stop_process"), input: toolSchemas.stop_process }),
  z.object({ tool: z.literal("search"), input: toolSchemas.search }),
  z.object({ tool: z.literal("list_files"), input: toolSchemas.list_files }),
  z.object({ tool: z.literal("changes"), input: toolSchemas.changes }),
  z.object({ tool: z.literal("preview"), input: toolSchemas.preview }),
]);

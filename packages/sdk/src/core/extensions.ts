import { shellQuote } from "../internal/provider-utils";
import { SandboxError } from "./errors";
import type {
  CommandResult,
  FileWatchEvent,
  GitCloneOptions,
  GitStatus,
  RunCodeLanguage,
  RunCodeOptions,
  RunCommandOptions,
  SandboxFileStat,
  ShellValue,
} from "./types";

/**
 * Generic implementations of DX helpers built on top of `run`. They work on every provider
 * because every provider supports running commands. Providers can override the file operations
 * with native implementations through the optional `SandboxRuntime.files` methods.
 */
export interface ExtensionContext {
  provider: string;
  run(command: string, options?: RunCommandOptions): Promise<CommandResult>;
}

function fileError(
  context: ExtensionContext,
  operation: string,
  result: CommandResult,
  fallbackMessage: string,
): SandboxError {
  const output = (result.stderr || result.stdout).trim();
  return new SandboxError({
    code: /no such file|not found|does not exist/i.test(output) ? "not_found" : "internal",
    provider: context.provider,
    operation,
    message: output || fallbackMessage,
  });
}

const statFormats = ["-c '%F|%s|%Y'", "-f '%HT|%z|%m'"] as const; // GNU, then BSD

export async function genericStat(
  context: ExtensionContext,
  path: string,
): Promise<SandboxFileStat> {
  let last: CommandResult | undefined;
  for (const format of statFormats) {
    const result = await context.run(`stat ${format} -- ${shellQuote(path)}`);
    if (result.success) {
      const [typeRaw = "", sizeRaw = "0", mtimeRaw = ""] = result.stdout.trim().split("|");
      const lower = typeRaw.toLowerCase();
      const type = lower.includes("directory")
        ? ("directory" as const)
        : lower.includes("symbolic")
          ? ("symlink" as const)
          : lower.includes("regular") || lower.includes("file")
            ? ("file" as const)
            : ("unknown" as const);
      const mtime = Number(mtimeRaw);
      return {
        path,
        type,
        size: Number(sizeRaw) || 0,
        modifiedAt: Number.isFinite(mtime) && mtime > 0 ? new Date(mtime * 1000) : undefined,
      };
    }
    last = result;
    if (/no such file/i.test(result.stderr)) break;
  }
  throw fileError(context, "files.stat", last!, `Unable to stat ${path}`);
}

export async function genericTransfer(
  context: ExtensionContext,
  operation: "move" | "copy",
  source: string,
  destination: string,
): Promise<void> {
  const command =
    operation === "move"
      ? `mv -- ${shellQuote(source)} ${shellQuote(destination)}`
      : `cp -r -- ${shellQuote(source)} ${shellQuote(destination)}`;
  const result = await context.run(command);
  if (!result.success) {
    throw fileError(
      context,
      `files.${operation}`,
      result,
      `Unable to ${operation} ${source} to ${destination}`,
    );
  }
}

interface LanguageSpec {
  extension: string;
  command: (file: string) => string;
  /** Retried once when the first attempt fails in a recognizable, recoverable way. */
  fallback?: { command: (file: string) => string; when: (result: CommandResult) => boolean };
}

const languages: Record<RunCodeLanguage, LanguageSpec> = {
  python: {
    extension: "py",
    command: (file) => `python3 ${shellQuote(file)}`,
    fallback: {
      command: (file) => `python ${shellQuote(file)}`,
      when: (result) => result.exitCode === 127,
    },
  },
  javascript: {
    extension: "mjs",
    command: (file) => `node ${shellQuote(file)}`,
  },
  typescript: {
    extension: "ts",
    command: (file) => `node ${shellQuote(file)}`,
    fallback: {
      command: (file) => `node --experimental-strip-types ${shellQuote(file)}`,
      when: (result) =>
        !result.success && /strip-types|typescript|unknown file extension/i.test(result.stderr),
    },
  },
  bash: {
    extension: "sh",
    command: (file) => `bash ${shellQuote(file)}`,
  },
};

export async function genericRunCode(
  context: ExtensionContext,
  writeFile: (path: string, value: string) => Promise<void>,
  removeFile: (path: string) => Promise<void>,
  code: string,
  options: RunCodeOptions = {},
): Promise<CommandResult> {
  const { language = "python", ...runOptions } = options;
  const spec = languages[language];
  if (!spec) {
    throw new SandboxError({
      code: "invalid_input",
      provider: context.provider,
      operation: "process.runCode",
      message: `Unsupported runCode language: ${String(language)}`,
    });
  }
  const file = `/tmp/sandbox-sdk-${Math.random().toString(36).slice(2, 12)}.${spec.extension}`;
  await writeFile(file, code);
  try {
    let result = await context.run(spec.command(file), runOptions);
    if (spec.fallback && spec.fallback.when(result)) {
      result = await context.run(spec.fallback.command(file), runOptions);
    }
    return result;
  } finally {
    await removeFile(file).catch(() => undefined);
  }
}

export function buildShellCommand(
  strings: TemplateStringsArray,
  values: ReadonlyArray<ShellValue>,
): string {
  let command = strings[0] ?? "";
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const quoted = Array.isArray(value)
      ? value.map((item) => shellQuote(String(item))).join(" ")
      : shellQuote(String(value));
    command += quoted + (strings[index + 1] ?? "");
  }
  return command;
}

function repositoryDirectory(url: string): string {
  const trimmed = url.replace(/\/+$/, "").replace(/\.git$/, "");
  const segment = trimmed.split(/[/:]/).pop();
  if (!segment) {
    throw new Error(`Unable to derive a target directory from repository URL: ${url}`);
  }
  return segment;
}

function withAuth(
  context: ExtensionContext,
  url: string,
  auth: { username?: string; token: string },
): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SandboxError({
      code: "invalid_input",
      provider: context.provider,
      operation: "git.clone",
      message: "Git authentication requires an http(s) repository URL",
    });
  }
  parsed.username = auth.username ?? "x-access-token";
  parsed.password = auth.token;
  return parsed.toString();
}

export async function genericGitClone(
  context: ExtensionContext,
  cwd: string,
  url: string,
  options: GitCloneOptions = {},
): Promise<{ path: string }> {
  const target = options.path ?? repositoryDirectory(url);
  const remote = options.auth ? withAuth(context, url, options.auth) : url;
  let command = "git clone";
  if (options.branch) command += ` --branch ${shellQuote(options.branch)}`;
  if (options.depth !== undefined) command += ` --depth ${Math.floor(options.depth)}`;
  command += ` -- ${shellQuote(remote)} ${shellQuote(target)}`;
  const result = await context.run(command, {
    timeout: options.timeout,
    signal: options.signal,
  });
  if (!result.success) {
    let output = (result.stderr || result.stdout).trim();
    if (options.auth) output = output.replaceAll(options.auth.token, "[REDACTED]");
    throw new SandboxError({
      code: /not found|does not exist|repository .* not found/i.test(output)
        ? "not_found"
        : /authentication|denied|401|403/i.test(output)
          ? "authentication"
          : "process_failed",
      provider: context.provider,
      operation: "git.clone",
      message: output || `git clone failed with exit code ${result.exitCode}`,
    });
  }
  const path = target.startsWith("/") ? target : `${cwd}/${target}`.replace(/\/{2,}/g, "/");
  return { path };
}

/**
 * Polling directory watcher for providers without native file watching. Compares
 * `find` + `stat` snapshots of the watched tree between polls.
 */
export async function genericWatch(
  context: ExtensionContext,
  path: string,
  onEvent: (event: FileWatchEvent) => void,
  options: { recursive: boolean; pollInterval: number; signal?: AbortSignal },
): Promise<{ stop(): Promise<void> }> {
  const probe = await context.run(`stat -c '%n' -- ${shellQuote(path)}`);
  const format = probe.success ? "-c '%n|%s|%Y'" : "-f '%N|%z|%m'";
  const depth = options.recursive ? "" : " -maxdepth 1";
  const command = `find ${shellQuote(path)} -mindepth 1${depth} -exec stat ${format} -- {} + 2>/dev/null`;
  const snapshot = async (): Promise<Map<string, string>> => {
    const result = await context.run(command);
    const entries = new Map<string, string>();
    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      const mtimeIndex = line.lastIndexOf("|");
      const sizeIndex = line.lastIndexOf("|", mtimeIndex - 1);
      if (sizeIndex <= 0) continue;
      entries.set(line.slice(0, sizeIndex), line.slice(sizeIndex + 1));
    }
    return entries;
  };
  let previous = await snapshot();
  let stopped = false;
  void (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, options.pollInterval));
      if (stopped) break;
      let current: Map<string, string>;
      try {
        current = await snapshot();
      } catch {
        continue;
      }
      if (stopped) break;
      for (const [entry, signature] of current) {
        const before = previous.get(entry);
        if (before === undefined) onEvent({ type: "create", path: entry });
        else if (before !== signature) onEvent({ type: "modify", path: entry });
      }
      for (const entry of previous.keys()) {
        if (!current.has(entry)) onEvent({ type: "remove", path: entry });
      }
      previous = current;
    }
  })();
  const stop = async () => {
    stopped = true;
  };
  options.signal?.addEventListener("abort", () => void stop(), { once: true });
  return { stop };
}

export async function genericGitStatus(
  context: ExtensionContext,
  directory: string,
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<GitStatus> {
  const result = await context.run(`git -C ${shellQuote(directory)} status --porcelain=v1 -b`, options);
  if (!result.success) {
    const output = (result.stderr || result.stdout).trim();
    throw new SandboxError({
      code: /not a git repository|not found/i.test(output) ? "not_found" : "process_failed",
      provider: context.provider,
      operation: "git.status",
      message: output || `git status failed with exit code ${result.exitCode}`,
    });
  }
  const lines = result.stdout.split("\n").filter(Boolean);
  const header = lines[0] ?? "";
  const branchMatch = header.match(/^## ([^.\s]+)/);
  const ahead = header.match(/ahead (\d+)/);
  const behind = header.match(/behind (\d+)/);
  const entries = lines.slice(1).map((line) => ({
    status: line.slice(0, 2).trim() || line.slice(0, 2),
    path: line.slice(3),
  }));
  return {
    branch: branchMatch?.[1],
    ahead: ahead ? Number(ahead[1]) : undefined,
    behind: behind ? Number(behind[1]) : undefined,
    dirty: entries.length > 0,
    entries,
  };
}

export async function genericGitCommand(
  context: ExtensionContext,
  operation: "pull" | "checkout",
  directory: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const quotedArgs = args.map(shellQuote).join(" ");
  const command = `git -C ${shellQuote(directory)} ${operation}${quotedArgs ? ` ${quotedArgs}` : ""}`;
  const result = await context.run(command, options);
  if (!result.success) {
    const output = (result.stderr || result.stdout).trim();
    throw new SandboxError({
      code: /not a git repository|not found|did not match/i.test(output)
        ? "not_found"
        : "process_failed",
      provider: context.provider,
      operation: `git.${operation}`,
      message: output || `git ${operation} failed with exit code ${result.exitCode}`,
    });
  }
}

#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { getProviderMetadata, providers } from "./metadata";
import { memory } from "./providers/memory";

export interface CliIo {
  stdout: { write(value: string): void };
  stderr: { write(value: string): void };
  env: NodeJS.ProcessEnv;
}

const usage = `Usage:
  sandbox-sdk adapters
  sandbox-sdk doctor
  sandbox-sdk capabilities --adapter <name>
  sandbox-sdk run --adapter <name> [--live] -- <command>...

doctor never creates a sandbox and never prints secret values.
run defaults to memory. Other adapters require --live.
`;

export async function runCli(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr, env: process.env },
): Promise<number> {
  const { command, flags, rest } = parseArgs(argv);
  if (!command || command === "help" || flags.help) {
    io.stdout.write(usage);
    return command ? 0 : 1;
  }
  if (command === "adapters") {
    for (const provider of providers) {
      const env = provider.environmentVariables.join(", ") || "none";
      io.stdout.write(`${provider.id}\t${provider.displayName}\t${env}\n`);
    }
    return 0;
  }
  if (command === "doctor") {
    for (const provider of providers) {
      if (provider.environmentVariables.length === 0) {
        io.stdout.write(`${provider.id}\tready\tno credentials required\n`);
        continue;
      }
      const missing = provider.environmentVariables.filter((name) => !io.env[name]);
      io.stdout.write(
        missing.length === 0
          ? `${provider.id}\tpresent\t${provider.environmentVariables.length} env vars set\n`
          : `${provider.id}\tmissing\t${missing.join(", ")}\n`,
      );
    }
    return 0;
  }
  if (command === "capabilities") {
    const id = flagValue(flags, "adapter");
    if (!id) {
      io.stderr.write("capabilities requires --adapter <name>\n");
      return 1;
    }
    try {
      const metadata = getProviderMetadata(id);
      for (const [name, mode] of Object.entries(metadata.capabilities)) {
        if (mode) io.stdout.write(`${name}\t${mode}\n`);
      }
      return 0;
    } catch (error) {
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (command === "run") {
    const id = flagValue(flags, "adapter") ?? "memory";
    if (rest.length === 0) {
      io.stderr.write("run requires a command after --\n");
      return 1;
    }
    if (id !== "memory" && !flags.live) {
      io.stderr.write(`run --adapter ${id} creates a real sandbox. Pass --live to continue.\n`);
      return 1;
    }
    if (id !== "memory") {
      io.stderr.write("Only --adapter memory is available without extra provider SDKs in this CLI.\n");
      return 1;
    }
    const sandbox = await memory().create();
    try {
      const result = await sandbox.run(rest.join(" "));
      if (result.stdout) io.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
      if (result.stderr) io.stderr.write(result.stderr);
      return result.success ? 0 : result.exitCode || 1;
    } finally {
      await sandbox.stop();
    }
  }
  io.stderr.write(`Unknown command: ${command}\n${usage}`);
  return 1;
}

function parseArgs(argv: readonly string[]) {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  let command: string | undefined;
  let inRest = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (inRest) {
      rest.push(arg);
      continue;
    }
    if (arg === "--") {
      inRest = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (!name) continue;
      if (inline !== undefined) {
        flags[name] = inline;
        continue;
      }
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags[name] = next;
        index += 1;
        continue;
      }
      flags[name] = true;
      continue;
    }
    if (!command) command = arg;
    else rest.push(arg);
  }
  return { command, flags, rest };
}

function flagValue(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

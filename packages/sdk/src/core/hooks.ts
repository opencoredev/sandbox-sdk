import { redactSensitive } from "./errors";
import type { CommandResult } from "./types";

export interface SandboxHookEvent {
  provider: string;
  id?: string;
  operation?: string;
  cwd?: string;
  command?: string;
  exitCode?: number;
  success?: boolean;
  code?: string;
  message?: string;
}

export interface SandboxHooks {
  onCreate?: (event: SandboxHookEvent) => void | Promise<void>;
  onRun?: (event: SandboxHookEvent) => void | Promise<void>;
  onError?: (event: SandboxHookEvent) => void | Promise<void>;
  onStop?: (event: SandboxHookEvent) => void | Promise<void>;
  onDestroy?: (event: SandboxHookEvent) => void | Promise<void>;
}

export async function emitHook(
  hook: ((event: SandboxHookEvent) => void | Promise<void>) | undefined,
  event: SandboxHookEvent,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(sanitizeHookEvent(event));
  } catch {
    // Hooks must not break sandbox operations.
  }
}

export function sanitizeHookEvent(event: SandboxHookEvent): SandboxHookEvent {
  return {
    ...event,
    command: event.command ? redactSensitive(event.command) : undefined,
    cwd: event.cwd,
  };
}

export function runHookSnapshot(result: CommandResult): Pick<SandboxHookEvent, "exitCode" | "success"> {
  return { exitCode: result.exitCode, success: result.success };
}

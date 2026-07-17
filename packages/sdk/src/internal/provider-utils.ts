import { SandboxError } from "../core/errors";
import type { CommandInput, ExposedPort, FileValue, SandboxSnapshot } from "../core/types";

export async function toUint8Array(value: FileValue): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  const response = new Response(value);
  return new Uint8Array(await response.arrayBuffer());
}

export function commandString(input: CommandInput): string {
  if (typeof input === "string") return input;
  return [input.command, ...(input.args ?? [])].map(shellQuote).join(" ");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function authenticatedPortRequest(
  provider: string,
  baseUrl: string,
  path: string,
  init: RequestInit,
  authenticationHeaders: Readonly<Record<string, string>>,
): Promise<Response> {
  const base = new URL(baseUrl);
  const target = new URL(path, base);
  if (target.origin !== base.origin) {
    throw new SandboxError({
      code: "invalid_input",
      provider,
      operation: "ports.request",
      message: "Authenticated port requests must stay on the preview origin",
    });
  }
  return fetch(target, {
    ...init,
    redirect: "manual",
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      ...authenticationHeaders,
    },
  });
}

export function portResult(
  port: number,
  url: string,
  isPublic: boolean,
  authenticated: boolean,
  request?: (path?: string, init?: RequestInit) => Promise<Response>,
): ExposedPort {
  return {
    port,
    url,
    public: isPublic,
    authenticated,
    request,
    toJSON: () => ({
      port,
      url: authenticated ? redactUrl(url) : url,
      public: isPublic,
      authenticated,
    }),
  };
}

function redactUrl(url: string): string {
  const parsed = new URL(url);
  for (const key of parsed.searchParams.keys()) parsed.searchParams.set(key, "[REDACTED]");
  return parsed.toString();
}

export function unsupported(provider: string, operation: string): never {
  throw new SandboxError({
    code: "unsupported",
    provider,
    operation,
    message: `${provider} does not support normalized ${operation}`,
  });
}

export function unsupportedSnapshots(provider: string) {
  return {
    create: async (): Promise<SandboxSnapshot> => unsupported(provider, "snapshot.create"),
    delete: async (): Promise<void> => unsupported(provider, "snapshot.delete"),
    restore: async (): Promise<void> => unsupported(provider, "snapshot.restore"),
  };
}

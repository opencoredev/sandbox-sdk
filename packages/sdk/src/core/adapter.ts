import { connectSandbox, createSandbox, listSandboxes } from "./sandbox";
import type { SandboxProvider, SandboxRuntime, ProviderCreateOptions } from "./provider";
import type { SandboxHooks } from "./hooks";
import type { GitSource, Sandbox, SandboxSummary } from "./types";

export interface AdapterCreateOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeout?: number;
  signal?: AbortSignal;
  source?: { git: GitSource };
  hooks?: SandboxHooks;
}

export interface SandboxAdapter<TRaw = unknown> extends Omit<SandboxProvider<TRaw>, "create"> {
  create(options?: AdapterCreateOptions): Promise<Sandbox<TRaw>>;
  createRuntime(options: ProviderCreateOptions): Promise<SandboxRuntime<TRaw>>;
  connectSandbox?(options: { id: string } & AdapterCreateOptions): Promise<Sandbox<TRaw>>;
}

export function isSandboxAdapter<TRaw>(
  provider: SandboxProvider<TRaw> | SandboxAdapter<TRaw>,
): provider is SandboxAdapter<TRaw> {
  return (
    typeof (provider as SandboxAdapter<TRaw>).createRuntime === "function" &&
    provider.createRuntime !== provider.create
  );
}

/**
 * Lifts a runtime provider into the Sandbox 2 factory surface:
 * `await using sandbox = await adapter.create()`.
 */
export function defineAdapter<TRaw>(
  provider: SandboxProvider<TRaw> | SandboxAdapter<TRaw>,
): SandboxAdapter<TRaw> {
  if (isSandboxAdapter(provider)) return provider;
  const createRuntime = (options: ProviderCreateOptions) =>
    (provider.createRuntime ?? provider.create).call(provider, options);

  const adapter = {
    ...provider,
    createRuntime,
    create(options: AdapterCreateOptions = {}) {
      return createSandbox({
        provider: adapter,
        ...options,
      });
    },
    connectSandbox: provider.connect
      ? (options: { id: string } & AdapterCreateOptions) =>
          connectSandbox({ provider: adapter, ...options })
      : undefined,
    list: provider.list
      ? (options?: { signal?: AbortSignal }): Promise<SandboxSummary[]> =>
          listSandboxes(adapter, options)
      : undefined,
  } as SandboxAdapter<TRaw>;
  return adapter;
}

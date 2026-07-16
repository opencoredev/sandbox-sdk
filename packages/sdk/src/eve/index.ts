import type {
  SandboxBackend,
  SandboxBackendHandle,
  SandboxNetworkPolicy as EveNetworkPolicy,
  SandboxSession as EveSandboxSession,
} from "eve/sandbox";
import { isSandboxError, SandboxError } from "../core/errors";
import type {
  ManagedSandboxProvider,
  ManagedSandboxSession,
  SandboxNetworkPolicy,
  SandboxProvider,
} from "../core/provider";
import { toAISandboxSession } from "../ai/index";

export interface EveSandboxUseOptions {
  networkPolicy?: EveNetworkPolicy;
}

export interface CreateEveSandboxBackendOptions {
  provider: SandboxProvider<unknown>;
  ports?: ReadonlyArray<number>;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/** Create an Eve beta SandboxBackend backed by a managed sandbox-sdk provider. */
export function createEveSandboxBackend(
  options: CreateEveSandboxBackendOptions,
): SandboxBackend<EveSandboxUseOptions, EveSandboxUseOptions> {
  const managed = requireManaged(options.provider);
  const prewarmed = new Set<string>();

  return {
    name: `sandbox-sdk-${options.provider.id}`,
    async prewarm(input) {
      if (prewarmed.has(input.templateKey)) return { reused: true };
      input.log?.(`Preparing ${options.provider.id} sandbox template ${input.templateKey}`);
      const template = await managed.create({
        sessionId: templateSessionId(input.templateKey),
        identity: input.templateKey,
        cwd: options.cwd,
        env: options.env,
        ports: options.ports,
        onFirstCreate: async (sandbox) => {
          await Promise.all(
            input.seedFiles.map((file) =>
              sandbox.files.write(resolveSandboxPath(sandbox.cwd, file.path), file.content),
            ),
          );
          if (input.bootstrap) {
            const templateView: ManagedSandboxSession = {
              id: templateSessionId(input.templateKey),
              sandbox,
              defaultWorkingDirectory: sandbox.cwd,
              ports: options.ports ?? [],
              getPortUrl: async () => {
                throw new Error("Template ports are not available during prewarm");
              },
              stop: async () => {},
              resume: async () => {},
              destroy: async () => {},
            };
            await input.bootstrap({ use: createUseFn(templateView) });
          }
        },
      });
      await template.destroy();
      prewarmed.add(input.templateKey);
      return { reused: false };
    },
    async create(input) {
      const reconnectId = readString(input.existingMetadata, "managedSessionId");
      let managedSession: ManagedSandboxSession;
      if (reconnectId) {
        managedSession = await managed.resume({ sessionId: reconnectId });
      } else {
        managedSession = await managed.create({
          sessionId: input.sessionKey,
          identity: input.templateKey ?? undefined,
          cwd: options.cwd,
          env: options.env,
          ports: options.ports,
        });
      }
      return createHandle(managedSession, createUseFn(managedSession), options.provider.id);
    },
  };
}

function createHandle(
  managed: ManagedSandboxSession,
  useSessionFn: (options?: EveSandboxUseOptions) => Promise<EveSandboxSession>,
  providerId: string,
): SandboxBackendHandle<EveSandboxUseOptions> {
  return {
    session: toEveSession(managed, providerId),
    useSessionFn,
    async captureState() {
      return {
        backendName: `sandbox-sdk-${providerId}`,
        sessionKey: managed.id,
        metadata: { managedSessionId: managed.id, provider: providerId },
      };
    },
    shutdown: () => managed.stop(),
  };
}

function createUseFn(managed: ManagedSandboxSession) {
  const session = toEveSession(managed, managed.sandbox.provider);
  return async (options?: EveSandboxUseOptions): Promise<EveSandboxSession> => {
    if (options?.networkPolicy !== undefined) {
      if (!managed.setNetworkPolicy) throw unsupportedNetwork(managed.sandbox.provider);
      await managed.setNetworkPolicy(toCoreNetworkPolicy(options.networkPolicy));
    }
    return session;
  };
}

function toEveSession(managed: ManagedSandboxSession, providerId: string): EveSandboxSession {
  const ai = toAISandboxSession(managed.sandbox);
  return {
    run: ai.run,
    spawn: ai.spawn,
    readFile: ai.readFile,
    readBinaryFile: ai.readBinaryFile,
    readTextFile: ai.readTextFile,
    writeFile: ai.writeFile,
    writeBinaryFile: ai.writeBinaryFile,
    writeTextFile: ai.writeTextFile,
    id: managed.id,
    resolvePath: (path) => resolveSandboxPath(managed.defaultWorkingDirectory, path),
    async removePath({ path, force }) {
      try {
        await managed.sandbox.files.remove(
          resolveSandboxPath(managed.defaultWorkingDirectory, path),
        );
      } catch (error) {
        if (force && isSandboxError(error) && error.code === "not_found") return;
        throw error;
      }
    },
    async setNetworkPolicy(policy) {
      if (!managed.setNetworkPolicy) throw unsupportedNetwork(providerId);
      await managed.setNetworkPolicy(toCoreNetworkPolicy(policy));
    },
  };
}

function toCoreNetworkPolicy(policy: EveNetworkPolicy): SandboxNetworkPolicy {
  if (policy === "allow-all") return { mode: "allow-all" };
  if (policy === "deny-all") return { mode: "deny-all" };
  return { mode: "native", value: policy };
}

function resolveSandboxPath(cwd: string, path: string): string {
  if (path.includes("\0") || path.split("/").includes("..")) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "eve",
      operation: "resolvePath",
      message: `Invalid sandbox path: ${path}`,
    });
  }
  return path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
}

function templateSessionId(templateKey: string): string {
  return `eve-template-${templateKey}`;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function unsupportedNetwork(provider: string): SandboxError {
  return new SandboxError({
    code: "unsupported",
    provider,
    operation: "network.policy",
    message: `Provider ${provider} does not support network-policy mutation`,
  });
}

function requireManaged(provider: SandboxProvider<unknown>): ManagedSandboxProvider {
  if (!provider.managed) {
    throw new SandboxError({
      code: "unsupported",
      provider: provider.id,
      operation: "eve.createBackend",
      message: `Provider ${provider.id} does not implement managed sandbox sessions`,
    });
  }
  return provider.managed;
}

export type { SandboxBackend, SandboxBackendHandle, EveSandboxSession };

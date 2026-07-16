import { SandboxError } from "../core/errors";
import type {
  ManagedSandboxProvider,
  ManagedSandboxSession,
  SandboxProvider,
} from "../core/provider";
import { createSandbox } from "../core/sandbox";
import type { Sandbox } from "../core/types";
import type { SandboxNetworkPolicy } from "../core/provider";

type TemplateFile = { path: string; content: Uint8Array };

/**
 * Shared managed lifecycle for built-in providers. Provider-native implementations
 * can replace this optional surface without changing `createSandbox()`.
 */
export function withManagedSessions<TRaw>(
  provider: SandboxProvider<TRaw>,
  configuredPorts: ReadonlyArray<number> = [],
  lifecycle: {
    stop?: (sandbox: Sandbox<TRaw>) => Promise<void>;
    resume?: (sandbox: Sandbox<TRaw>) => Promise<void>;
    destroy?: (sandbox: Sandbox<TRaw>) => Promise<void>;
    setPorts?: (
      sandbox: Sandbox<TRaw>,
      ports: ReadonlyArray<number>,
      signal?: AbortSignal,
    ) => Promise<void>;
    setNetworkPolicy?: (sandbox: Sandbox<TRaw>, policy: SandboxNetworkPolicy) => Promise<void>;
  } = {},
): SandboxProvider<TRaw> {
  const sessions = new Map<string, ManagedSandboxSession>();
  const templates = new Map<string, Promise<TemplateFile[]>>();

  const managed: ManagedSandboxProvider = {
    async create(options) {
      const existing = sessions.get(options.sessionId);
      if (existing) return existing;
      const sandbox = await createSandbox({
        provider,
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
      });
      const ports = new Set([...configuredPorts, ...(options.ports ?? [])]);
      let ownedTemplate: Promise<TemplateFile[]> | undefined;
      try {
        if (options.identity) {
          let template = templates.get(options.identity);
          if (!template) {
            template = (async () => {
              await options.onFirstCreate?.(sandbox);
              return captureFiles(sandbox, sandbox.cwd);
            })();
            ownedTemplate = template;
            templates.set(options.identity, template);
            await template;
          } else {
            await restoreFiles(sandbox, await template);
          }
        } else {
          await options.onFirstCreate?.(sandbox);
        }
        const session = createManagedSession(
          options.sessionId,
          sandbox,
          ports,
          sessions,
          lifecycle,
        );
        sessions.set(options.sessionId, session);
        return session;
      } catch (error) {
        if (
          options.identity &&
          ownedTemplate &&
          templates.get(options.identity) === ownedTemplate
        ) {
          templates.delete(options.identity);
        }
        try {
          if (lifecycle.destroy) await lifecycle.destroy(sandbox);
          else await sandbox.stop();
        } catch (cleanupError) {
          if (error instanceof Error) {
            Object.defineProperty(error, "cleanupError", {
              value: cleanupError,
              enumerable: false,
            });
          }
        }
        throw error;
      }
    },
    async resume(options) {
      const session = sessions.get(options.sessionId);
      if (!session) {
        throw new SandboxError({
          code: "not_found",
          provider: provider.id,
          operation: "managed.resume",
          message: `Managed sandbox session not found: ${options.sessionId}`,
        });
      }
      await session.resume();
      return session;
    },
  };
  return { ...provider, managed };
}

function createManagedSession<TRaw>(
  id: string,
  sandbox: Sandbox<TRaw>,
  initialPorts: Set<number>,
  sessions: Map<string, ManagedSandboxSession>,
  lifecycle: {
    stop?: (sandbox: Sandbox<TRaw>) => Promise<void>;
    resume?: (sandbox: Sandbox<TRaw>) => Promise<void>;
    destroy?: (sandbox: Sandbox<TRaw>) => Promise<void>;
    setPorts?: (
      sandbox: Sandbox<TRaw>,
      ports: ReadonlyArray<number>,
      signal?: AbortSignal,
    ) => Promise<void>;
    setNetworkPolicy?: (sandbox: Sandbox<TRaw>, policy: SandboxNetworkPolicy) => Promise<void>;
  },
): ManagedSandboxSession {
  let destroyed = false;
  let stopped = false;
  const assertActive = () => {
    if (destroyed) {
      throw new SandboxError({
        code: "terminated",
        provider: sandbox.provider,
        operation: "managed.session",
        message: `Managed sandbox session has been destroyed: ${id}`,
      });
    }
  };
  const session: ManagedSandboxSession = {
    id,
    sandbox,
    defaultWorkingDirectory: sandbox.cwd,
    get ports() {
      return [...initialPorts];
    },
    async getPortUrl({ port, protocol }) {
      assertActive();
      if (!initialPorts.has(port)) {
        throw new SandboxError({
          code: "invalid_input",
          provider: sandbox.provider,
          operation: "managed.getPortUrl",
          message: `Port ${port} is not exposed by this session`,
        });
      }
      const exposed = await sandbox.ports.expose(port);
      const url = new URL(exposed.url);
      if (protocol) url.protocol = `${protocol}:`;
      return url.toString().replace(/\/$/, "");
    },
    async stop() {
      assertActive();
      if (stopped) return;
      await lifecycle.stop?.(sandbox);
      stopped = true;
    },
    async resume() {
      assertActive();
      if (!stopped) return;
      await lifecycle.resume?.(sandbox);
      stopped = false;
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      sessions.delete(id);
      if (lifecycle.destroy) await lifecycle.destroy(sandbox);
      else await sandbox.stop();
    },
    ...(lifecycle.setPorts
      ? {
          async setPorts(ports: ReadonlyArray<number>, options?: { signal?: AbortSignal }) {
            assertActive();
            await lifecycle.setPorts!(sandbox, ports, options?.signal);
            initialPorts.clear();
            for (const port of ports) initialPorts.add(port);
          },
        }
      : {}),
    ...(lifecycle.setNetworkPolicy
      ? {
          setNetworkPolicy: (policy: SandboxNetworkPolicy) => {
            assertActive();
            return lifecycle.setNetworkPolicy!(sandbox, policy);
          },
        }
      : {}),
  };
  return session;
}

async function captureFiles(sandbox: Sandbox, path: string): Promise<TemplateFile[]> {
  const result: TemplateFile[] = [];
  for (const entry of await sandbox.files.list(path)) {
    if (entry.type === "directory") result.push(...(await captureFiles(sandbox, entry.path)));
    else if (entry.type === "file")
      result.push({
        path: entry.path,
        content: await sandbox.files.read(entry.path),
      });
  }
  return result;
}

async function restoreFiles(sandbox: Sandbox, files: ReadonlyArray<TemplateFile>): Promise<void> {
  await Promise.all(files.map((file) => sandbox.files.write(file.path, file.content)));
}

import type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import type { Experimental_SandboxSession } from "ai";
import { SandboxError } from "../core/errors";
import type {
  ManagedSandboxSession,
  SandboxNetworkPolicy,
  SandboxProvider,
} from "../core/provider";
import { toAISandboxSession } from "./index";

export interface CreateSandboxHarnessProviderOptions {
  provider: SandboxProvider<unknown>;
  ports?: ReadonlyArray<number>;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
}

/** Create an AI SDK Harness sandbox provider backed by any managed sandbox-sdk provider. */
export function createSandboxHarnessProvider(
  options: CreateSandboxHarnessProviderOptions,
): HarnessV1SandboxProvider {
  const managed = requireManaged(options.provider);
  return {
    specificationVersion: "harness-sandbox-v1",
    providerId: `sandbox-sdk:${options.provider.id}`,
    async createSession(createOptions = {}) {
      const sessionId = createOptions.sessionId ?? crypto.randomUUID();
      const session = await managed.create({
        sessionId,
        identity: createOptions.identity,
        cwd: options.cwd,
        env: options.env,
        ports: options.ports,
        signal: createOptions.abortSignal,
        onFirstCreate: createOptions.onFirstCreate
          ? (sandbox) =>
              createOptions.onFirstCreate!(toAISandboxSession(sandbox), {
                abortSignal: createOptions.abortSignal,
              })
          : undefined,
      });
      return toHarnessSession(session);
    },
    async resumeSession(resumeOptions) {
      return toHarnessSession(
        await managed.resume({
          sessionId: resumeOptions.sessionId,
          signal: resumeOptions.abortSignal,
        }),
      );
    },
  };
}

function toHarnessSession(session: ManagedSandboxSession): HarnessV1NetworkSandboxSession {
  const restricted = toAISandboxSession(session.sandbox);
  return {
    ...restricted,
    id: session.id,
    defaultWorkingDirectory: session.defaultWorkingDirectory,
    get ports() {
      return session.ports;
    },
    getPortUrl: (options) => session.getPortUrl(options),
    stop: () => session.stop(),
    destroy: () => session.destroy(),
    ...(session.setPorts
      ? {
          setPorts: (ports: ReadonlyArray<number>, options?: { abortSignal?: AbortSignal }) =>
            session.setPorts!(ports, { signal: options?.abortSignal }),
        }
      : {}),
    ...(session.setNetworkPolicy
      ? {
          setNetworkPolicy: (policy: HarnessV1NetworkPolicy) =>
            session.setNetworkPolicy!(toCoreNetworkPolicy(policy)),
        }
      : {}),
    restricted: (): Experimental_SandboxSession => restricted,
  };
}

function toCoreNetworkPolicy(policy: HarnessV1NetworkPolicy): SandboxNetworkPolicy {
  if (policy.mode !== "custom") return policy;
  return {
    mode: "custom",
    allowedHosts: policy.allowedHosts,
    allowedCIDRs: policy.allowedCIDRs,
    deniedCIDRs: policy.deniedCIDRs,
  };
}

function requireManaged(provider: SandboxProvider<unknown>) {
  if (!provider.managed) {
    throw new SandboxError({
      code: "unsupported",
      provider: provider.id,
      operation: "harness.createProvider",
      message: `Provider ${provider.id} does not implement managed sandbox sessions`,
    });
  }
  return provider.managed;
}

export type {
  HarnessV1NetworkPolicy,
  HarnessV1NetworkSandboxSession,
  HarnessV1SandboxProvider,
} from "@ai-sdk/harness";

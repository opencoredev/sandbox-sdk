import type { SandboxProvider } from "../../core/provider";
import {
  agentos as createAgentOsRuntime,
  type AgentOsProviderOptions,
  type AgentOsSandbox,
} from "../agentos";

/** Options passed to the AgentOS VM that powers the Local provider. */
export interface LocalOptions extends AgentOsProviderOptions {}

/** Native AgentOS access for a Local sandbox. */
export type LocalSandbox = AgentOsSandbox;

export { localCapabilities } from "../capabilities";

/**
 * Runs an isolated AgentOS VM inside the current Node.js process.
 *
 * AgentOS is an implementation detail of the Local provider. Outbound networking and host bindings
 * are denied by default; pass native options under `agentOs` to configure the VM explicitly.
 */
export function local(options: LocalOptions = {}): SandboxProvider<LocalSandbox> {
  return createAgentOsRuntime(options);
}

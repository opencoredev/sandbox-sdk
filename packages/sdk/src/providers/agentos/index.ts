import type { AgentOs } from "@rivet-dev/agentos-core";
import {
  createAgentosProvider,
  createRegistry,
  type AgentosOptions,
  type AgentosProvider,
} from "./provider.js";

export type { AgentosOptions, AgentosProvider } from "./provider.js";

// Embedded identity is scoped to this module in this JS process, across factories.
const registry = createRegistry<AgentOs>();

/** Embedded, Docker-free V8/WebAssembly runtime. Docker remains local()'s default. */
export function agentos(options: AgentosOptions = {}): AgentosProvider {
  return createAgentosProvider(options, () => import("@rivet-dev/agentos-core"), registry);
}

import { createAgent37Provider, type Agent37Options, type Agent37Provider } from "./provider.js";

export type {
  Agent37Capability,
  Agent37Native,
  Agent37Options,
  Agent37Plane,
  Agent37Provider,
} from "./provider.js";

/** Agent 37 (https://www.agent37.com) cloud sandboxes through its Sandbox API: no other package to install. */
export function agent37(options: Agent37Options = {}): Agent37Provider {
  return createAgent37Provider(options);
}

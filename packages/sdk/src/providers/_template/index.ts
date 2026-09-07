import { defineAdapter, type SandboxAdapter } from "../../core/adapter";
import type { SandboxProvider } from "../../core/provider";
import { assertNotAborted, unsupported, unsupportedSnapshots } from "../../internal/provider-utils";
import { defineCapabilities } from "../../core/capabilities";

const exampleCapabilities = defineCapabilities({
  "files.read": "full",
  "files.write": "full",
  "files.list": "full",
  "files.remove": "full",
  "process.run": "combined-stream",
});

/** Copy this factory. Do not export `_template` from the package. */
export function example(): SandboxAdapter<{ id: string }> {
  const provider: SandboxProvider<{ id: string }> = {
    id: "example",
    capabilities: exampleCapabilities,
    async create(createOptions) {
      assertNotAborted(createOptions.signal);
      return {
        id: "example",
        raw: { id: "example" },
        capabilities: exampleCapabilities,
        files: {
          async write() {
            unsupported("example", "files.write");
          },
          async read() {
            unsupported("example", "files.read");
          },
          async list() {
            return [];
          },
          async mkdir() {},
          async remove() {},
          async exists() {
            return false;
          },
        },
        async run() {
          unsupported("example", "process.run");
        },
        async start() {
          unsupported("example", "process.start");
        },
        async expose() {
          unsupported("example", "ports.expose");
        },
        snapshots: unsupportedSnapshots("example"),
        async destroy() {},
        async stop() {},
      };
    },
  };
  return defineAdapter(provider);
}

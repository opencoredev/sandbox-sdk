import { Template } from "../../../packages/sdk/node_modules/e2b/dist/index.js";

// From the repository root: bun bench/templates/e2b/build.ts [same-spec|advertised-default] [name]
// E2B_API_KEY must be set. Builds are retained; running this does not create sandboxes.
const variant = process.argv[2] ?? "same-spec";
const hardware = variant === "same-spec"
  ? { cpuCount: 4, memoryMB: 8192 }
  : variant === "advertised-default"
    ? { cpuCount: 2, memoryMB: 4096 }
    : undefined;
if (!hardware) throw new Error("Expected same-spec or advertised-default");
const name = process.argv[3] ?? `sandbox-bench-${variant}`;
const build = await Template.build(Template().fromTemplate("base"), name, hardware);
console.log(JSON.stringify({ variant, name: build.name, templateId: build.templateId, buildId: build.buildId, ...hardware }));

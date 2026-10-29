// Temporary live check for SBX-74 (not committed): exercises the Freestyle native API against the real service.
import { createSandbox, listSandboxes, reapSandboxes } from "../src/index.js";
import { freestyle } from "../src/providers/freestyle/index.js";

const run = `sbx74-fs-native-${Date.now().toString(36)}`;
const provider = freestyle();
const created: string[] = [];
const box = await createSandbox(provider, { labels: { "smoke-run": run } });
created.push(box.id);
try {
  await box.files.write("hello.txt", "native hello\n");
  const vm = await box.native.request<{ id: string; state: string }>("GET", "/v5/vms/{vmId}");
  console.log("native.request GET /v5/vms/{vmId}:", vm.id === box.id, vm.state);
  const response = await box.native.fetch("GET", "/v5/vms/{vmId}/fs/read", { query: { path: "/workspace/hello.txt" } });
  console.log("native.fetch fs/read:", response.status, JSON.stringify(await response.text()));
  const exec = await box.native.request<{ statusCode: number; stdout: string }>("POST", "/v5/vms/{vmId}/exec-await", { body: { command: "echo via-native", linuxUser: "root" } });
  console.log("native.request POST exec-await:", exec.statusCode, JSON.stringify(exec.stdout));
  const missing = await box.native.fetch("GET", "/v5/vms/{vmId}/fs/read", { query: { path: "/workspace/nope" } }).then(() => "resolved", (error: { code?: string; message?: string }) => `${error.code}: ${error.message?.slice(0, 160)}`);
  console.log("native.fetch missing file:", missing);
  const page = await provider.api.request<{ vms: { id: string }[]; totalCount: number }>("GET", "/v5/vms", { query: { limit: 100 } });
  console.log("provider.api.request GET /v5/vms: has box", page.vms.some(v => v.id === box.id), "total", page.totalCount);
  const snapshots = await provider.api.request<{ snapshots: unknown[]; totalCount: number }>("GET", "/v5/snapshots", { query: { limit: 1 } });
  console.log("provider.api.request GET /v5/snapshots:", Array.isArray(snapshots.snapshots), typeof snapshots.totalCount);
  const sdkVm = await box.native.sdk(() => import("freestyle"));
  const sdkExec = await sdkVm.exec({ command: "echo via-sdk", linuxUser: "root" });
  console.log("native.sdk Vm.exec:", sdkVm.id === box.id, sdkExec.statusCode, JSON.stringify(sdkExec.stdout));
  const client = await provider.api.sdk(() => import("freestyle"));
  console.log("api.sdk client.vms.get:", (await client.vms.get(box.id)).id === box.id);
} finally {
  await box.destroy();
  const left = await listSandboxes(provider, { labels: { "smoke-run": run } });
  const reaped = left.length ? await reapSandboxes(provider, { labels: { "smoke-run": run } }) : 0;
  console.log(`cleanup: created ${created.length}, left after destroy ${left.length}, reaped ${reaped}`);
}

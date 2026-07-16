import { requireCapability, type Sandbox } from "../src";

export async function snapshot(sandbox: Sandbox) {
  requireCapability(sandbox, "snapshot.create");
  return sandbox.snapshots.create({ name: "workspace" });
}

import { capabilityMode, supports, type Sandbox } from "../src";

export async function optionalSnapshot(sandbox: Sandbox) {
  if (!supports(sandbox, "snapshot.create")) return;
  console.log(capabilityMode(sandbox, "snapshot.create"));
  return sandbox.snapshots.create({ name: "configured" });
}

import type { Sandbox } from "../src";

export async function copyBinary(sandbox: Sandbox) {
  await sandbox.files.write("pixel.bin", new Uint8Array([0, 127, 255]));
  return sandbox.files.read("pixel.bin");
}

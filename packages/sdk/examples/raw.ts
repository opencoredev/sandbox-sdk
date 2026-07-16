import { createSandbox } from "../src";
import { e2b } from "../src/providers/e2b";

export async function native() {
  const sandbox = await createSandbox({ provider: e2b() });
  const commands = sandbox.raw.commands;
  void commands;
  return sandbox;
}

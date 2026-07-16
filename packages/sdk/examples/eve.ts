import { defineSandbox } from "eve/sandbox";
import { createEveSandboxBackend } from "../src/eve";
import { local } from "../src/providers/local";

export default defineSandbox({
  backend: createEveSandboxBackend({ provider: local() }),
  revalidationKey: () => "repo-bootstrap-v1",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.writeTextFile({ path: "READY", content: "yes\n" });
  },
  async onSession({ use }) {
    await use();
  },
});

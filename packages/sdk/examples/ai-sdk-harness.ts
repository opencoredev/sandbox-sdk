import { createSandboxHarnessProvider } from "../src/ai/harness";
import { local } from "../src/providers/local";

export const sandboxProvider = createSandboxHarnessProvider({
  provider: local(),
  ports: [4317, 8080],
  cwd: "/workspace",
});

const session = await sandboxProvider.createSession({
  sessionId: "coding-session",
  identity: "repo-setup-v1",
  async onFirstCreate(sandbox) {
    await sandbox.run({ command: "npm install" });
  },
});

await session.stop();
const resumed = await sandboxProvider.resumeSession!({ sessionId: "coding-session" });
await resumed.destroy?.();

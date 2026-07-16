import { ToolLoopAgent, type LanguageModel } from "ai";
import { createSandbox } from "../src";
import { createSandboxToolApproval, createSandboxTools, toAISandboxSession } from "../src/ai";
import { vercel } from "../src/providers/vercel";

declare const model: LanguageModel;

const sandbox = await createSandbox({ provider: vercel({ runtime: "node24" }) });
const agent = new ToolLoopAgent({
  model,
  tools: createSandboxTools(),
  toolApproval: createSandboxToolApproval(),
});

try {
  await agent.generate({
    prompt: "Read package.json and run the test script.",
    experimental_sandbox: toAISandboxSession(sandbox),
  });
} finally {
  await sandbox.stop();
}

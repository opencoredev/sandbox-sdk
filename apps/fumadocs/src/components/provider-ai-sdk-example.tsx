import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";

const providers = {
  local: {
    importName: "local",
    importPath: "@opencoredev/sandbox-sdk/local",
    factory: "local()",
  },
  e2b: {
    importName: "e2b",
    importPath: "@opencoredev/sandbox-sdk/e2b",
    factory: "e2b()",
  },
  daytona: {
    importName: "daytona",
    importPath: "@opencoredev/sandbox-sdk/daytona",
    factory: "daytona()",
  },
  vercel: {
    importName: "vercel",
    importPath: "@opencoredev/sandbox-sdk/vercel",
    factory: 'vercel({ runtime: "node24" })',
  },
  upstash: {
    importName: "upstash",
    importPath: "@opencoredev/sandbox-sdk/upstash",
    factory: 'upstash({ runtime: "node" })',
  },
  box: {
    importName: "box",
    importPath: "@opencoredev/sandbox-sdk/box",
    factory: "box({ ttlSeconds: 900 })",
  },
  railway: {
    importName: "railway",
    importPath: "@opencoredev/sandbox-sdk/railway",
    factory: "railway({ idleTimeoutMinutes: 5 })",
  },
  tenki: {
    importName: "tenki",
    importPath: "@opencoredev/sandbox-sdk/tenki",
    factory: "tenki({ idleTimeoutMinutes: 10 })",
  },
} as const;

export function ProviderAISDKExample({ provider }: { provider: keyof typeof providers }) {
  const selected = providers[provider];
  const code = `import { ToolLoopAgent, type LanguageModel } from "ai";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import {
  createSandboxToolApproval,
  createSandboxTools,
  toAISandboxSession,
} from "@opencoredev/sandbox-sdk/ai";
import { ${selected.importName} } from "${selected.importPath}";

export async function runSandboxAgent(model: LanguageModel) {
  await using sandbox = await createSandbox({
    provider: ${selected.factory},
  });
  const aiSandbox = toAISandboxSession(sandbox);
  const agent = new ToolLoopAgent({
    model,
    instructions: \`Work only in the provided sandbox.\\n\\n\${aiSandbox.description}\`,
    tools: createSandboxTools(),
    toolApproval: createSandboxToolApproval(),
  });

  return await agent.generate({
    prompt: "Inspect the repository, run its tests, and summarize the result.",
    experimental_sandbox: aiSandbox,
  });
}`;

  return (
    <>
      <p>
        This provider works with AI SDK <code>ToolLoopAgent</code> through the normalized sandbox
        session. Pass the language model from your existing AI SDK provider or AI Gateway setup.
      </p>
      <DynamicCodeBlock lang="ts" code={code} codeblock={{ title: "sandbox-agent.ts" }} />
      <p>
        See the <a href="/docs/integrations/ai-sdk">AI SDK guide</a> for approval flows, direct
        session access, and HarnessAgent alternatives.
      </p>
    </>
  );
}

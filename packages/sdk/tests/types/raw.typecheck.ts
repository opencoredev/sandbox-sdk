import type { SandboxInstance as BlaxelNative } from "@blaxel/core";
import type { Sandbox as DaytonaNative } from "@daytona/sdk";
import type { Sandbox as E2BNative } from "e2b";
import type { Sandbox as VercelNative } from "@vercel/sandbox";
import type { Box as UpstashNative } from "@upstash/box";
import { createSandbox } from "../../src";
import { agentos, type AgentOsSandbox } from "../../src/providers/agentos";
import { blaxel } from "../../src/providers/blaxel";
import { daytona } from "../../src/providers/daytona";
import { e2b } from "../../src/providers/e2b";
import { local, type LocalSandbox } from "../../src/providers/local";
import { vercel } from "../../src/providers/vercel";
import { upstash } from "../../src/providers/upstash";

async function rawTypes() {
  const localSandbox: LocalSandbox = (await createSandbox({ provider: local() })).raw;
  const agentosSandbox: AgentOsSandbox = (await createSandbox({ provider: agentos() })).raw;
  const e2bSandbox: E2BNative = (await createSandbox({ provider: e2b() })).raw;
  const daytonaSandbox: DaytonaNative = (await createSandbox({ provider: daytona() })).raw;
  const vercelSandbox: VercelNative = (await createSandbox({ provider: vercel() })).raw;
  const upstashSandbox: UpstashNative = (await createSandbox({ provider: upstash() })).raw;
  const blaxelSandbox: BlaxelNative = (await createSandbox({ provider: blaxel() })).raw;
  void [
    localSandbox,
    agentosSandbox,
    e2bSandbox,
    daytonaSandbox,
    vercelSandbox,
    upstashSandbox,
    blaxelSandbox,
  ];
}

async function disposableSandbox() {
  await using sandbox = await createSandbox({ provider: local() });
  const raw: LocalSandbox = sandbox.raw;
  void raw;
}

void rawTypes;
void disposableSandbox;

// @ts-expect-error cwd must be a string.
createSandbox({ provider: local(), cwd: 123 });

import type { SandboxInstance as BlaxelNative } from "@blaxel/core";
import type { Sandbox as DaytonaNative } from "@daytona/sdk";
import type { Sandbox as E2BNative } from "e2b";
import type { Sandbox as VercelNative } from "@vercel/sandbox";
import type { Box as UpstashNative } from "@upstash/box";
import type { SandboxProvider } from "../../src/core/provider";
import { agentos, type AgentOsSandbox } from "../../src/providers/agentos";
import { blaxel } from "../../src/providers/blaxel";
import { daytona } from "../../src/providers/daytona";
import { e2b } from "../../src/providers/e2b";
import { local, type LocalSandbox } from "../../src/providers/local";
import { vercel } from "../../src/providers/vercel";
import { upstash } from "../../src/providers/upstash";

const localContract: SandboxProvider<LocalSandbox> = local();
const agentosContract: SandboxProvider<AgentOsSandbox> = agentos();
const e2bContract: SandboxProvider<E2BNative> = e2b();
const daytonaContract: SandboxProvider<DaytonaNative> = daytona();
const vercelContract: SandboxProvider<VercelNative> = vercel();
const upstashContract: SandboxProvider<UpstashNative> = upstash();
const blaxelContract: SandboxProvider<BlaxelNative> = blaxel();
void [
  localContract,
  agentosContract,
  e2bContract,
  daytonaContract,
  vercelContract,
  upstashContract,
  blaxelContract,
];

// @ts-expect-error Explicit access-token authentication requires the complete credential triple.
vercel({ token: "token" });

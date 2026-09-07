import type { Sandbox as DaytonaNative } from "@daytona/sdk";
import type { Sandbox as E2BNative } from "e2b";
import type { Sandbox as VercelNative } from "@vercel/sandbox";
import type { Box as UpstashNative } from "@upstash/box";
import type { SandboxAdapter } from "../../src/core/adapter";
import { agentos, type AgentOsSandbox } from "../../src/providers/agentos";
import { box, type AsciiBoxSandbox } from "../../src/providers/box";
import { daytona } from "../../src/providers/daytona";
import { e2b } from "../../src/providers/e2b";
import { local, type LocalSandbox } from "../../src/providers/local";
import { railway } from "../../src/providers/railway";
import { vercel } from "../../src/providers/vercel";
import { upstash } from "../../src/providers/upstash";

const localContract: SandboxAdapter<LocalSandbox> = local();
const agentosContract: SandboxAdapter<AgentOsSandbox> = agentos();
const e2bContract: SandboxAdapter<E2BNative> = e2b();
const daytonaContract: SandboxAdapter<DaytonaNative> = daytona();
const vercelContract: SandboxAdapter<VercelNative> = vercel();
const upstashContract: SandboxAdapter<UpstashNative> = upstash();
const boxContract: SandboxAdapter<AsciiBoxSandbox> = box({ apiKey: "test" });
const railwayContract: SandboxAdapter<import("railway").Sandbox> = railway();
void [
  localContract,
  agentosContract,
  e2bContract,
  daytonaContract,
  vercelContract,
  upstashContract,
  boxContract,
  railwayContract,
];

// @ts-expect-error Railway accepts either a checkpoint or a template, never both.
railway({ checkpoint: "base", template: {} as import("railway").SandboxTemplate });

// @ts-expect-error Explicit access-token authentication requires the complete credential triple.
vercel({ token: "token" });

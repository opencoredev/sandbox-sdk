import type { Sandbox as DaytonaNative } from "@daytona/sdk";
import type { Sandbox as E2BNative } from "e2b";
import type { Sandbox as VercelNative } from "@vercel/sandbox";
import type { Box as UpstashNative } from "@upstash/box";
import type { SandboxProvider } from "../../src/core/provider";
import { agentos, type AgentOsSandbox } from "../../src/providers/agentos";
import { box, type AsciiBoxSandbox } from "../../src/providers/box";
import { daytona } from "../../src/providers/daytona";
import { e2b } from "../../src/providers/e2b";
import { local, type LocalSandbox } from "../../src/providers/local";
import { railway } from "../../src/providers/railway";
import { tenki, type TenkiSession } from "../../src/providers/tenki";
import { vercel } from "../../src/providers/vercel";
import { upstash } from "../../src/providers/upstash";

const localContract: SandboxProvider<LocalSandbox> = local();
const agentosContract: SandboxProvider<AgentOsSandbox> = agentos();
const e2bContract: SandboxProvider<E2BNative> = e2b();
const daytonaContract: SandboxProvider<DaytonaNative> = daytona();
const vercelContract: SandboxProvider<VercelNative> = vercel();
const upstashContract: SandboxProvider<UpstashNative> = upstash();
const boxContract: SandboxProvider<AsciiBoxSandbox> = box({ apiKey: "test" });
const railwayContract: SandboxProvider<import("railway").Sandbox> = railway();
const tenkiContract: SandboxProvider<TenkiSession> = tenki();
void [
  localContract,
  agentosContract,
  e2bContract,
  daytonaContract,
  vercelContract,
  upstashContract,
  boxContract,
  railwayContract,
  tenkiContract,
];

// @ts-expect-error Railway accepts either a checkpoint or a template, never both.
railway({ checkpoint: "base", template: {} as import("railway").SandboxTemplate });

// @ts-expect-error Tenki boots from an image, a snapshot, or a template spec, never two at once.
tenki({ image: "acme/node-env", snapshotId: "snapshot" });

// @ts-expect-error Explicit access-token authentication requires the complete credential triple.
vercel({ token: "token" });

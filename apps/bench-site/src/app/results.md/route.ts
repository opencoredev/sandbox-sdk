import { agentMarkdown } from "@/lib/agent-data";

export const dynamic = "force-static";

export function GET() {
  return new Response(agentMarkdown(), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}

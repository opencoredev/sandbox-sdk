import { agentData } from "@/lib/agent-data";

export const dynamic = "force-static";

export function GET() {
  return Response.json(agentData());
}

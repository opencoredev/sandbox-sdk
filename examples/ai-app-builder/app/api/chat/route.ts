import { convertToModelMessages, validateUIMessages, type UIMessage } from "ai";
import { cookies } from "next/headers";
import { buildApp } from "../../../lib/agent";
import { resolveModel } from "../../../lib/model";
import { sessionSandbox } from "../../../lib/sandbox";
import { newSessionId, parseSessionId, sessionCookie } from "../../../lib/session";

export const maxDuration = 300;

export async function POST(request: Request) {
  const body: unknown = await request.json();
  const messages = await validateUIMessages<UIMessage>({
    messages:
      typeof body === "object" && body !== null && "messages" in body ? body.messages : undefined,
  });

  const jar = await cookies();
  let session = parseSessionId(jar.get(sessionCookie)?.value);
  if (!session) {
    session = newSessionId();
    jar.set(sessionCookie, session, { httpOnly: true, sameSite: "lax", path: "/" });
  }

  const latest = messages.findLast((message) => message.role === "user");
  const prompt =
    latest?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ?? "";
  const box = await sessionSandbox(session);
  const result = await buildApp({
    box,
    model: resolveModel(),
    messages: await convertToModelMessages(messages),
    prompt,
    abortSignal: request.signal,
  });
  return result.toUIMessageStreamResponse({ originalMessages: messages });
}

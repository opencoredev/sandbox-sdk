import { cookies } from "next/headers";
import { destroySessionSandbox } from "../../../lib/sandbox";
import { parseSessionId, sessionCookie } from "../../../lib/session";

/** Destroys this browser session's sandbox. The next message creates a fresh one. */
export async function DELETE() {
  const jar = await cookies();
  const session = parseSessionId(jar.get(sessionCookie)?.value);
  if (session) {
    await destroySessionSandbox(session);
    jar.delete(sessionCookie);
  }
  return new Response(null, { status: 204 });
}

import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { previewPort, sessionSandbox } from "../../../lib/sandbox";
import { parseSessionId, sessionCookie } from "../../../lib/session";

// Hop-by-hop or already-decoded by fetch; forwarding them would corrupt the body.
const dropped = ["content-encoding", "content-length", "transfer-encoding", "connection"];

const notice = (message: string, status: number) =>
  new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0b0b0c;color:#8d8e93;font:14px ui-monospace,monospace">${message}</body>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    },
  );

/**
 * Proxies the session's sandbox preview. Provider access headers (Daytona's token) stay
 * on the server, and local Docker previews bound to 127.0.0.1 work from any device.
 */
export async function GET(request: NextRequest, context: RouteContext<"/preview/[[...path]]">) {
  const session = parseSessionId((await cookies()).get(sessionCookie)?.value);

  if (!session) return notice("No sandbox yet. Send a prompt first.", 404);

  const box = await sessionSandbox(session);
  const preview = await box.preview(previewPort);
  const { path = [] } = await context.params;
  const base = preview.url.endsWith("/") ? preview.url : `${preview.url}/`;
  const target = new URL(path.map(encodeURIComponent).join("/") + request.nextUrl.search, base);

  let upstream: Response;

  try {
    upstream = await fetch(target, {
      headers: preview.headers,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return notice(`Nothing is listening on port ${previewPort} yet.`, 502);
  }

  const headers = new Headers(upstream.headers);

  for (const name of dropped) headers.delete(name);
  headers.set("cache-control", "no-store");

  return new Response(upstream.body, { status: upstream.status, headers });
}

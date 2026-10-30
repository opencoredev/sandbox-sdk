import { randomUUID } from "node:crypto";
import { z } from "zod";

export const sessionCookie = "sbx-session";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sessionIdSchema = z.string().regex(uuid).brand<"SessionId">();

/** A browser session id. One session owns exactly one sandbox. */
export type SessionId = z.infer<typeof sessionIdSchema>;

export function parseSessionId(value: string | undefined): SessionId | undefined {
  const parsed = sessionIdSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

export function newSessionId(): SessionId {
  return sessionIdSchema.parse(randomUUID());
}

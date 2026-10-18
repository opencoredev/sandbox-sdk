import { randomUUID } from "node:crypto";

export const sessionCookie = "sbx-session";

/** A browser session id. One session owns exactly one sandbox. */
export type SessionId = string & { readonly __brand: "SessionId" };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseSessionId(value: string | undefined): SessionId | undefined {
  return value && uuid.test(value) ? (value as SessionId) : undefined;
}

export function newSessionId(): SessionId {
  return randomUUID() as SessionId;
}

import { z } from "zod";
import type { Json } from "./json.js";
import { UnverifiedOwnershipError } from "./ownership.js";

const sandboxIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/);
const stateSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const cleanupSchema = z.enum(["succeeded", "failed", "already-absent", "unknown"]);

const causeSchema = z.object({
  admittedByThisCall: z.boolean().optional(),
  sandboxId: sandboxIdSchema.optional(),
  nativeState: stateSchema.optional(),
  cleanupCode: stateSchema.optional(),
  cleanupOutcome: cleanupSchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  providerCode: z.string().optional(),
  requestId: z.string().optional(),
  operation: z.string().optional(),
  stage: z.string().optional(),
  elapsedMs: z.number().finite().nonnegative().optional(),
});

export const failureOutcomeSchema = z.object({
  kind: z.literal("failure"),
  note: z.string(),
  unverifiedSandboxId: sandboxIdSchema.optional(),
  ownershipReleased: z.boolean().optional(),
  cleanupResolved: z.literal("absent").optional(),
  sandboxId: sandboxIdSchema.optional(),
  code: z.string().optional(),
  cause: causeSchema.optional(),
  stage: z.string().optional(),
  elapsedMs: z.number().finite().nonnegative().optional(),
  clockPhase: z.enum(["adapter-create", "first-command", "sdk-init"]).optional(),
  lateSettlement: z
    .object({
      settled: z.boolean(),
      unverifiedSandboxId: sandboxIdSchema.optional(),
      sandboxId: z.string().optional(),
      stage: z.string(),
      cleanupOutcome: cleanupSchema.optional(),
      code: z.string().optional(),
      cause: causeSchema.optional(),
    })
    .optional(),
});

export type FailureOutcome = z.infer<typeof failureOutcomeSchema>;

const nativeCode = z.union([z.string(), z.number().finite()]).transform(String);

const metadataSchema = z.object({
  admittedByThisCall: z.boolean().optional().catch(undefined),
  sandboxId: sandboxIdSchema.optional().catch(undefined),
  nativeState: stateSchema.optional().catch(undefined),
  state: stateSchema.optional().catch(undefined),
  cleanupCode: stateSchema.optional().catch(undefined),
  cleanupOutcome: cleanupSchema.optional().catch(undefined),
  httpStatus: z.coerce.number().int().min(100).max(599).optional().catch(undefined),
  status: z.coerce.number().int().min(100).max(599).optional().catch(undefined),
  statusCode: z.coerce.number().int().min(100).max(599).optional().catch(undefined),
  providerCode: nativeCode.optional().catch(undefined),
  provider_code: nativeCode.optional().catch(undefined),
  code: nativeCode.optional().catch(undefined),
  requestId: z.string().optional().catch(undefined),
  request_id: z.string().optional().catch(undefined),
  operation: z.string().optional().catch(undefined),
  stage: z.string().optional().catch(undefined),
  elapsedMs: z.coerce.number().finite().nonnegative().optional().catch(undefined),
});

const thrownCode = z.object({ code: z.string() });
const thrownSandboxId = z.object({ sandboxId: z.string() });

/** Read attribution fields out of a text cause: JSON when it parses, else `key: value` pairs. */
function textMetadata(text: string): Json {
  // Parse JSON before extracting text so nested bodies/headers never become evidence.
  try {
    return JSON.parse(text);
  } catch {
    const fields: Record<string, string> = {};
    const safeText = text.split(/\b(?:body|headers|authorization)\s*[:=]/i)[0] ?? "";

    const pairs =
      /["']?\b(httpStatus|statusCode|status|providerCode|provider_code|code|requestId|request_id|operation|stage|elapsedMs|sandboxId|nativeState|state|cleanupCode|cleanupOutcome)\b["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'[^']*'|[\w./:-]+)/gi;

    for (const match of safeText.matchAll(pairs)) {
      const key = match[1],
        token = match[2];

      if (!key || !token) continue;

      if (token.startsWith('"')) {
        try {
          const value = z.string().safeParse(JSON.parse(token));

          if (value.success) fields[key] = value.data;
        } catch {
          /* Malformed quoted evidence is omitted. */
        }
      } else fields[key] = token.startsWith("'") ? token.slice(1, -1) : token;
    }

    const status = /\bHTTP\s+(\d{3})\b/i.exec(safeText)?.[1];

    if (status) fields.httpStatus = status;
    const prefix = /^([\w./-]+)\s+HTTP\s+\d{3}\b/.exec(safeText)?.[1];

    if (!fields.operation && prefix) fields.operation = prefix;

    return fields;
  }
}

/** Keep only attribution fields. Never serialize native bodies, headers or arbitrary causes. */
export function failureOutcome(cause: unknown, sanitize: (text: string) => string): FailureOutcome {
  const thrown = thrownCode.safeParse(cause);
  const code = thrown.success ? sanitize(thrown.data.code).slice(0, 100) : undefined;
  const inner = cause instanceof Error ? cause.cause : undefined;
  const innerText = inner instanceof Error ? inner.message : z.string().safeParse(inner).data;
  const evidence: z.infer<typeof causeSchema> = {};

  const parsed =
    innerText === undefined
      ? metadataSchema.safeParse(inner)
      : metadataSchema.safeParse(textMetadata(sanitize(innerText).slice(0, 16000)));

  if (parsed.success) {
    const v = parsed.data;

    if (v.admittedByThisCall !== undefined) evidence.admittedByThisCall = v.admittedByThisCall;

    const native = {
      sandboxId: v.sandboxId,
      nativeState: v.nativeState ?? v.state,
      cleanupCode: v.cleanupCode,
      cleanupOutcome: v.cleanupOutcome,
    };

    for (const key of ["sandboxId", "nativeState", "cleanupCode", "cleanupOutcome"] as const) {
      const value = native[key];

      if (!value) continue;
      const field = causeSchema.shape[key].safeParse(sanitize(value));

      if (field.success && field.data !== undefined) Object.assign(evidence, { [key]: field.data });
    }

    const status = v.httpStatus ?? v.statusCode ?? v.status;

    if (status !== undefined) evidence.httpStatus = status;
    const providerCode = v.providerCode ?? v.provider_code ?? v.code;
    const requestId = v.requestId ?? v.request_id;

    if (providerCode) evidence.providerCode = sanitize(providerCode).slice(0, 200);

    if (requestId) evidence.requestId = sanitize(requestId).slice(0, 200);

    if (v.operation) evidence.operation = sanitize(v.operation).slice(0, 200);

    if (v.stage) evidence.stage = sanitize(v.stage).slice(0, 200);

    if (v.elapsedMs !== undefined) evidence.elapsedMs = v.elapsedMs;
  }

  const thrownId = thrownSandboxId.safeParse(cause);

  const nativeId = thrownId.success
    ? sandboxIdSchema.safeParse(sanitize(thrownId.data.sandboxId))
    : null;

  const sandboxId = nativeId?.success ? nativeId.data : evidence.sandboxId;

  const unverified =
    cause instanceof UnverifiedOwnershipError
      ? sandboxIdSchema.safeParse(sanitize(cause.unverifiedSandboxId))
      : null;

  const outcome: FailureOutcome = {
    kind: "failure",
    note: sanitize(cause instanceof Error ? cause.message : "Unknown failure"),
    code,
  };

  if (sandboxId) outcome.sandboxId = sandboxId;

  if (unverified?.success) outcome.unverifiedSandboxId = unverified.data;

  if (Object.keys(evidence).length) outcome.cause = evidence;

  return outcome;
}

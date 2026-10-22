import { z } from "zod";

const causeSchema = z.object({
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
  code: z.string().optional(),
  cause: causeSchema.optional(),
  stage: z.string().optional(),
  elapsedMs: z.number().finite().nonnegative().optional(),
  clockPhase: z.enum(["adapter-create", "first-command", "sdk-init"]).optional(),
  lateSettlement: z.object({
    settled: z.boolean(),
    sandboxId: z.string().optional(),
    stage: z.string(),
    code: z.string().optional(),
    cause: causeSchema.optional(),
  }).optional(),
});
export type FailureOutcome = z.infer<typeof failureOutcomeSchema>;

/** Keep only attribution fields. Never serialize native bodies, headers or arbitrary causes. */
export function failureOutcome(error: unknown, sanitize: (text: string) => string): FailureOutcome {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? sanitize(error.code).slice(0, 100) : undefined;
  const raw = error instanceof Error ? error.cause : undefined;
  const cause: z.infer<typeof causeSchema> = {};
  const nativeCode = z.union([z.string(), z.number().finite()]).transform(String);
  const metadataSchema = z.object({
    httpStatus: z.coerce.number().int().min(100).max(599).optional().catch(undefined),
    status: z.coerce.number().int().min(100).max(599).optional().catch(undefined),
    statusCode: z.coerce.number().int().min(100).max(599).optional().catch(undefined),
    providerCode: nativeCode.optional().catch(undefined), provider_code: nativeCode.optional().catch(undefined), code: nativeCode.optional().catch(undefined),
    requestId: z.string().optional().catch(undefined), request_id: z.string().optional().catch(undefined), operation: z.string().optional().catch(undefined),
    stage: z.string().optional().catch(undefined), elapsedMs: z.coerce.number().finite().nonnegative().optional().catch(undefined),
  });
  let metadata: unknown = raw;
  if (typeof raw === "string" || raw instanceof Error) {
    const text = sanitize(typeof raw === "string" ? raw : raw.message).slice(0, 16000);
    // Parse JSON before extracting text so nested bodies/headers never become evidence.
    try { metadata = JSON.parse(text); }
    catch {
      const fields: Record<string, string> = {};
      const safeText = text.split(/\b(?:body|headers|authorization)\s*[:=]/i)[0] ?? "";
      const pairs = /["']?\b(httpStatus|statusCode|status|providerCode|provider_code|code|requestId|request_id|operation|stage|elapsedMs)\b["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'[^']*'|[\w./:-]+)/gi;
      for (const match of safeText.matchAll(pairs)) {
        const key = match[1], token = match[2];
        if (!key || !token) continue;
        if (token.startsWith('"')) {
          try {
            const value: unknown = JSON.parse(token);
            if (typeof value === "string") fields[key] = value;
          } catch { /* Malformed quoted evidence is omitted. */ }
        } else fields[key] = token.startsWith("'") ? token.slice(1, -1) : token;
      }
      const status = /\bHTTP\s+(\d{3})\b/i.exec(safeText)?.[1];
      if (status) fields.httpStatus = status;
      const prefix = /^([\w./-]+)\s+HTTP\s+\d{3}\b/.exec(safeText)?.[1];
      if (!fields.operation && prefix) fields.operation = prefix;
      metadata = fields;
    }
  }
  const parsed = metadataSchema.safeParse(metadata);
  if (parsed.success) {
    const v = parsed.data;
    const status = v.httpStatus ?? v.statusCode ?? v.status;
    if (status !== undefined) cause.httpStatus = status;
    const providerCode = v.providerCode ?? v.provider_code ?? v.code;
    const requestId = v.requestId ?? v.request_id;
    if (providerCode) cause.providerCode = sanitize(providerCode).slice(0, 200);
    if (requestId) cause.requestId = sanitize(requestId).slice(0, 200);
    if (v.operation) cause.operation = sanitize(v.operation).slice(0, 200);
    if (v.stage) cause.stage = sanitize(v.stage).slice(0, 200);
    if (v.elapsedMs !== undefined) cause.elapsedMs = v.elapsedMs;
  }
  return {kind: "failure", note: sanitize(error instanceof Error ? error.message : "Unknown failure"), code,
    ...(Object.keys(cause).length ? {cause} : {})};
}

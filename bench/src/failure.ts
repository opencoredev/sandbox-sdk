import { z } from "zod";

const causeSchema = z.object({
  httpStatus: z.number().int().min(100).max(599).optional(),
  providerCode: z.string().optional(),
  requestId: z.string().optional(),
  operation: z.string().optional(),
});
export const failureOutcomeSchema = z.object({
  kind: z.literal("failure"),
  note: z.string(),
  code: z.string().optional(),
  cause: causeSchema.optional(),
  stage: z.string().optional(),
  elapsedMs: z.number().finite().nonnegative().optional(),
});
export type FailureOutcome = z.infer<typeof failureOutcomeSchema>;

/** Keep only attribution fields. Never serialize native bodies, headers or arbitrary causes. */
export function failureOutcome(error: unknown, sanitize: (text: string) => string): FailureOutcome {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? sanitize(error.code).slice(0, 100) : undefined;
  const raw = error instanceof Error ? error.cause : undefined;
  const cause: z.infer<typeof causeSchema> = {};
  if (raw && typeof raw === "object" && !(raw instanceof Error)) {
    const metadata = z.object({
      httpStatus: z.number().optional(), status: z.number().optional(), statusCode: z.number().optional(),
      providerCode: z.string().optional(), code: z.string().optional(), requestId: z.string().optional(), operation: z.string().optional(),
    }).safeParse(raw);
    if (metadata.success) {
      const v = metadata.data;
      const status = v.httpStatus ?? v.statusCode ?? v.status;
      if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) cause.httpStatus = status;
      if (v.providerCode ?? v.code) cause.providerCode = sanitize(v.providerCode ?? v.code ?? "").slice(0, 200);
      if (v.requestId) cause.requestId = sanitize(v.requestId).slice(0, 200);
      if (v.operation) cause.operation = sanitize(v.operation).slice(0, 200);
    }
  } else if (typeof raw === "string" || raw instanceof Error) {
    // SDK redactors turn safe adapter evidence into text. Extract identifiers only.
    const text = sanitize(typeof raw === "string" ? raw : raw.message);
    const status = /\bHTTP\s+(\d{3})\b|\b(?:statusCode|status)\s*[:=]\s*(\d{3})\b/i.exec(text);
    if (status) cause.httpStatus = Number(status[1] ?? status[2]);
    if (cause.httpStatus !== undefined && (cause.httpStatus < 100 || cause.httpStatus > 599)) delete cause.httpStatus;
    const fields = [
      ["providerCode", /\b(?:providerCode|provider[_ -]?code|code)\s*[:=]\s*([\w.-]+)/i],
      ["requestId", /\brequest[_ -]?id\s*[:=]\s*([\w.-]+)/i],
      ["operation", /\boperation\s*[:=]\s*([\w./-]+)/i],
    ] as const;
    for (const [key, pattern] of fields) {
      const value = pattern.exec(text)?.[1];
      if (value) cause[key] = value.slice(0, 200);
    }
    const prefix = /^([\w./-]+)\s+HTTP\s+\d{3}\b/.exec(text)?.[1];
    if (!cause.operation && prefix) cause.operation = prefix;
  }
  return {kind: "failure", note: sanitize(error instanceof Error ? error.message : "Unknown failure"), code,
    ...(Object.keys(cause).length ? {cause} : {})};
}

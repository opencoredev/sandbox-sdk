import {
  SandboxError,
  describeNative,
  evidenceCause,
  reason,
  redacting,
  scrub,
  type ErrorCode,
  type NativeEvidence,
} from "../../errors.js";
import { decodeNative, type NativeError } from "../../shared/native-error.js";

export function failure(
  message: string,
  code: ErrorCode = "provider",
  sandboxId?: string,
  cause?: unknown,
) {
  return new SandboxError(
    code === "auth"
      ? message
      : code === "file_not_found"
        ? `${message}. Check the path.`
        : `${message}. Check boxd configuration and retry.`,
    {
      code,
      provider: "boxd",
      sandboxId,
      cause,
    },
  );
}

/**
 * The boxd control-plane calls the adapter names in a failure's evidence. Their errors name
 * machines and snapshots, never guest paths, so boxd's own message is kept for them.
 */
export type BoxdCall =
  | "machines.create"
  | "machines.waitUntilReady"
  | "machines.get"
  | "machines.list"
  | "machines.delete"
  | "machines.pause"
  | "machines.resume"
  | "machines.setEgressAllow"
  | "machines.proxies"
  | "snapshots.create"
  | "snapshots.get"
  | "snapshots.delete";

/** Where a failure happened. */
export interface BoxdContext {
  /** The sandbox the error belongs to. Never set while creating: an ID on a failed create claims ownership. */
  sandboxId?: string;
  /** The control-plane call that failed. */
  call?: BoxdCall;
  /** The machine that call touched, for evidence only; defaults to `sandboxId`. */
  machineId?: string;
}

/** boxd's evidence: the shared fields, plus the machine a failed call touched. */
export type BoxdEvidence = NativeEvidence & { machineId?: string };

const codes = new Map<number, ErrorCode>([
  [1, "aborted"],
  [3, "invalid_argument"],
  [4, "timeout"],
  [5, "not_found"],
  [6, "invalid_argument"],
  [9, "invalid_argument"],
  [7, "auth"],
  [8, "quota"],
  [12, "unsupported"],
  [14, "unavailable"],
  [16, "auth"],
]);

/** gRPC status names by code, so a report can tell ALREADY_EXISTS from FAILED_PRECONDITION. */
const statusNames = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
] as const;

const names = new Map<string, ErrorCode>([
  ["AuthenticationError", "auth"],
  ["PermissionDeniedError", "auth"],
  ["NotFoundError", "not_found"],
  ["RateLimitError", "quota"],
  ["APIConnectionError", "unavailable"],
]);

/** @boxd-sh/sdk error classes, kept by name in evidence. Anything else thrown is not named. */
const sdkClasses = new Set([
  ...names.keys(),
  "BoxdError",
  "ConflictError",
  "APIStatusError",
  "AgentOutdatedError",
  "FilesystemError",
]);

/** Request IDs and reasons are opaque tokens; anything else could be echoed request text. */
const token = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Metadata keys a request or trace ID could arrive under, in the order they are preferred. */
const requestIdKeys = [
  "x-request-id",
  "x-boxd-request-id",
  "request-id",
  "x-trace-id",
  "traceparent",
];

function requestIdOf(native: NativeError): string | undefined {
  if (native.requestId !== undefined) return native.requestId;

  for (const key of requestIdKeys) {
    const value = native.metadata.get(key) ?? native.headers.get(key);

    if (value !== undefined) return value;
  }

  return undefined;
}

/**
 * The machine fields a boxd failure keeps: the call, the gRPC status, the SDK's error class, boxd's
 * reason trailer and any request ID. boxd's message is kept only for a control-plane call.
 */
function boxdEvidence(
  native: NativeError,
  context: BoxdContext,
  detail: string | undefined,
  keys: readonly string[],
): BoxdEvidence {
  const denied = (value: string) => keys.some((key) => value.includes(key));
  const evidence: BoxdEvidence = {};

  if (context.call !== undefined) evidence.operation = context.call;
  const machineId = context.machineId ?? context.sandboxId;

  if (context.call !== undefined && machineId !== undefined && token.test(machineId))
    evidence.machineId = machineId;
  const status = native.grpcCode;

  if (status !== undefined) {
    const name = statusNames[status];
    evidence.providerCode = status;

    if (name !== undefined) evidence.providerStatus = name;
  }

  if (sdkClasses.has(native.name)) evidence.nativeName = native.name;

  // 0.3.x copies the server's x-boxd-error-reason trailer onto the error; a wrapped cause may carry it.
  const why = native.reason ?? decodeNative(native.cause).reason;

  if (why !== undefined && token.test(why) && !denied(why)) evidence.providerReason = why;
  const requestId = requestIdOf(native) ?? requestIdOf(decodeNative(native.cause));

  if (requestId !== undefined && token.test(requestId) && !denied(requestId))
    evidence.requestId = requestId;

  // The core bounds each field after redacting the sandbox's own secrets, so no cut here leaves part of one.
  if (context.call !== undefined && native.message)
    evidence.providerMessage = scrub(redacting(keys)(native.message));

  // The kept native detail usually repeats boxd's message; keep it only when it adds something.
  if (
    detail !== undefined &&
    !(evidence.providerMessage && detail.includes(evidence.providerMessage.slice(0, 80)))
  )
    evidence.native = detail;

  return evidence;
}

/**
 * Maps a boxd failure to a SandboxError with evidence in its cause. `secrets` are values to redact
 * besides `BOXD_API_KEY`, such as an `apiKey` passed to the provider.
 */
export function boxdError(
  cause: unknown,
  context: BoxdContext = {},
  secrets: readonly (string | undefined)[] = [],
): SandboxError {
  if (cause instanceof SandboxError) return cause;
  const { sandboxId } = context;

  const keys = [process.env.BOXD_API_KEY, ...secrets].filter(
    (key): key is string => key !== undefined && key !== "",
  );

  const native = decodeNative(cause);
  const status = native.grpcCode;

  // A gRPC status means boxd answered, and its text can echo paths or the request.
  const describe = (code: ErrorCode, known?: boolean) =>
    describeNative(cause, {
      code,
      known,
      status: status === undefined ? undefined : `gRPC ${status}`,
      redact: redacting(keys),
    });

  const evidence = (detail?: string) => evidenceCause(boxdEvidence(native, context, detail, keys));

  // 0.2.17's local machines.exec deadline is a plain BoxdError, without
  // grpcCode. Match its published message narrowly; never expose that message.
  if (native.name === "BoxdError" && /^exec timed out after \d+ms$/.test(native.message))
    return failure("boxd request timed out", "timeout", sandboxId, evidence());

  // gRPC NOT_FOUND covers both a missing VM ("VM not found") and a missing guest path
  // ("no such file on <machine>: <path>"). Only the latter is a file_not_found.
  if (/\bno such file\b/i.test(native.message))
    return failure("File does not exist", "file_not_found", sandboxId, evidence());

  const code =
    status === undefined
      ? (names.get(native.name) ?? "provider")
      : (codes.get(status) ?? "provider");

  // A recognized failure names only an allowlisted category, never native text or paths.
  const permissionDenied = /permission denied/i.test(native.message);
  const kept = describe(code, permissionDenied || undefined);

  return failure(
    permissionDenied
      ? "boxd guest filesystem permission denied"
      : `boxd request failed: ${reason(code, kept.detail)}`,
    code,
    sandboxId,
    evidence(kept.detail),
  );
}

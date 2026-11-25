/** Reads a thrown native SDK error once, at the adapter boundary, into one typed record. */
import { isNumber, isObject, isString } from "./narrow.js";

/**
 * The fields adapters read from a thrown native SDK error. A native SDK can throw anything, so
 * each optional field is set only when the thrown value carries it with that type. Text fields
 * classify the failure; they can echo the request, so what an adapter keeps goes through
 * `describeNative` or a bounded allowlist.
 */
export interface NativeError {
  /** An Error's `name`, or "" for anything else thrown. Bundlers can rename it with the class. */
  name: string;
  /** An Error's `message`, or "" for anything else thrown. */
  message: string;
  /** A numeric `status` field. */
  status?: number;
  /** A numeric `statusCode` field. */
  statusCode?: number;
  /** The status of an attached fetch `Response`. */
  responseStatus?: number;
  /** boxd's gRPC status code. */
  grpcCode?: number;
  /** A string or numeric `code` field: an errno such as `ENOENT`, a provider code, or an RPC code. */
  code?: string | number;
  /** Boat's API envelope error code. */
  apiCode?: string;
  /** The `error.code` of a parsed response body, which the Vercel SDK attaches as `json`. */
  bodyCode?: string;
  /** Daytona's `source`: which Daytona service answered. */
  source?: string;
  /** The request path a Freestyle API error names. */
  path?: string;
  /** A `requestId` field. */
  requestId?: string;
  /** A string `reason` field: a machine-readable failure reason, such as boxd's `x-boxd-error-reason` trailer. */
  reason?: string;
  /** The sandbox a failed Daytona create names. */
  sandboxId?: string;
  /** String values of a `headers` field: a fetch `Headers` or a plain object. */
  headers: ReadonlyMap<string, string>;
  /** String values of a gRPC `metadata` field. */
  metadata: ReadonlyMap<string, string>;
  /** The value this error wraps, for adapters that read a chain. */
  cause?: unknown;
}

/** Decodes the fields of {@link NativeError} from any thrown value. */
export function decodeNative(cause: unknown): NativeError {
  const error: NativeError = { name: "", message: "", headers: new Map(), metadata: new Map() };

  if (cause instanceof Error) {
    error.name = cause.name;
    error.message = cause.message;
  }

  if (!isObject(cause)) return error;

  if ("status" in cause && isNumber(cause.status)) error.status = cause.status;

  if ("statusCode" in cause && isNumber(cause.statusCode)) error.statusCode = cause.statusCode;

  if ("response" in cause && cause.response instanceof Response)
    error.responseStatus = cause.response.status;

  if ("grpcCode" in cause && isNumber(cause.grpcCode)) error.grpcCode = cause.grpcCode;

  if ("code" in cause && (isString(cause.code) || isNumber(cause.code))) error.code = cause.code;

  if ("apiCode" in cause && isString(cause.apiCode)) error.apiCode = cause.apiCode;

  if (
    "json" in cause &&
    isObject(cause.json) &&
    "error" in cause.json &&
    isObject(cause.json.error) &&
    "code" in cause.json.error &&
    isString(cause.json.error.code)
  )
    error.bodyCode = cause.json.error.code;

  if ("source" in cause && isString(cause.source)) error.source = cause.source;

  if ("path" in cause && isString(cause.path)) error.path = cause.path;

  if ("requestId" in cause && isString(cause.requestId)) error.requestId = cause.requestId;

  if ("reason" in cause && isString(cause.reason)) error.reason = cause.reason;

  if ("sandboxId" in cause && isString(cause.sandboxId)) error.sandboxId = cause.sandboxId;

  if ("headers" in cause && isObject(cause.headers)) {
    const entries =
      cause.headers instanceof Headers ? [...cause.headers] : Object.entries(cause.headers);

    error.headers = new Map(
      entries.filter((entry): entry is [string, string] => isString(entry[1])),
    );
  }

  // gRPC metadata comes as a fetch Headers (Connect), an iterable of [key, values] (nice-grpc), an
  // object with getMap() (grpc-js), or a plain object. Binary values are dropped and repeated
  // string values are joined with a comma, as gRPC does.
  if ("metadata" in cause && isObject(cause.metadata)) {
    const metadata = cause.metadata;

    try {
      const entries: unknown[] =
        metadata instanceof Headers || isIterable(metadata)
          ? [...metadata]
          : Object.entries(hasGetMap(metadata) ? metadata.getMap() : metadata);

      const result = new Map<string, string>();

      for (const entry of entries) {
        if (!Array.isArray(entry) || !isString(entry[0])) continue;
        const values: unknown[] = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
        const text = values.filter(isString);

        if (text.length > 0) result.set(entry[0], text.join(","));
      }

      error.metadata = result;
    } catch {
      // A native object whose accessors throw has no metadata worth reporting.
    }
  }

  if ("cause" in cause) error.cause = cause.cause;

  return error;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    isObject(value) && Symbol.iterator in value && typeof value[Symbol.iterator] === "function"
  );
}

function hasGetMap(value: unknown): value is { getMap(): object } {
  return isObject(value) && "getMap" in value && typeof value.getMap === "function";
}

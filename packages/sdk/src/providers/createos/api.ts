/** Wire contract from @nodeops-createos/sandbox 0.8.2. No dependency on that package. */
import {
  createHttpClient,
  type HttpRequest,
  type JsonValue,
  type JsonObject,
} from "../../provider.js";
import { isString, isNumber, isStringRecord } from "../../shared/narrow.js";
import { failure, mapError } from "./errors.js";

export function record(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unwrap(value: JsonValue | undefined): JsonValue | undefined {
  if (!record(value) || value.status !== "success")
    throw failure("CreateOS returned an invalid success envelope");

  return value.data;
}

export interface SandboxRecord {
  id: string;
  name?: string;
  status: string;
  labels: Record<string, string>;
  createdAt: number;
  ingress?: string;
}

const states = new Set([
  "creating",
  "running",
  "pausing",
  "paused",
  "resuming",
  "forking",
  "error",
  "destroying",
  "destroyed",
  "failed",
]);

export function sandboxRecord(value: JsonValue | undefined): SandboxRecord {
  if (
    !record(value) ||
    !isString(value.id) ||
    !value.id ||
    !isString(value.status) ||
    !states.has(value.status) ||
    !isString(value.created_at) ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    (value.labels !== undefined && !isStringRecord(value.labels))
  )
    throw failure("CreateOS returned invalid sandbox metadata");

  return {
    id: value.id,
    status: value.status,
    name: isString(value.name) ? value.name : undefined,
    labels: value.labels ?? {},
    createdAt: Date.parse(value.created_at),
    ingress:
      value.ingress_enabled === true && isString(value.ingress_url_template)
        ? value.ingress_url_template
        : undefined,
  };
}

export interface ProcessRecord {
  id: string;
  pid: number;
  treeExited: boolean;
  exitCode: number | null;
  signal: string | null;
}

export function processRecord(value: JsonValue | undefined): ProcessRecord {
  if (
    !record(value) ||
    !isString(value.process_id) ||
    !value.process_id ||
    !isNumber(value.pid) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    (value.tree_exited !== true && value.tree_exited !== false) ||
    (value.exit_code != null && (!isNumber(value.exit_code) || !Number.isInteger(value.exit_code)))
  )
    throw failure("CreateOS returned invalid process metadata");

  return {
    id: value.process_id,
    pid: value.pid,
    treeExited: value.tree_exited,
    exitCode: isNumber(value.exit_code) ? value.exit_code : null,
    signal: isString(value.signal) ? value.signal : null,
  };
}

export interface ApiOptions {
  baseUrl(): string;
  apiKey(): string;
  requestTimeoutMs: number;
}

export function createosApi(options: ApiOptions) {
  const http = createHttpClient({
    provider: "createos",
    label: "CreateOS",
    defaultPlane: "api",
    timeoutMs: options.requestTimeoutMs,
    planes: {
      api: {
        baseUrl: options.baseUrl,
        auth: () => ({ "X-Api-Key": options.apiKey() }),
      },
    },
    mapError,
    authHint: "Set CREATEOS_SANDBOX_API_KEY or pass apiKey to createos().",
  });

  const json = async (request: HttpRequest<"api">) => unwrap(await http.json(request));

  async function pages(request: HttpRequest<"api">, legacyKey: string): Promise<JsonValue[]> {
    const items: JsonValue[] = [];

    for (;;) {
      const value = await json({
        ...request,
        query: { ...request.query, limit: 500, offset: items.length },
      });

      if (Array.isArray(value)) return [...items, ...value];

      if (!record(value)) throw failure("CreateOS returned an invalid list");
      const page = value.data ?? value[legacyKey];

      if (!Array.isArray(page)) throw failure("CreateOS returned an invalid list page");
      const total = record(value.pagination) ? value.pagination.total : undefined;

      if (total !== undefined && (!isNumber(total) || !Number.isSafeInteger(total) || total < 0))
        throw failure("CreateOS returned an invalid pagination total");
      items.push(...page);

      if (total === undefined || items.length >= Number(total)) return items;

      if (!page.length) throw failure("CreateOS pagination stopped before the reported total");
    }
  }

  return { http, json, pages };
}

export type CreateosApi = ReturnType<typeof createosApi>;

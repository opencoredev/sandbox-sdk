import { z } from "zod";
import { createRequire } from "node:module";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { deadline } from "./timing.js";

const statusFields = z.object({
  status: z.number().int().min(100).max(599).optional().catch(undefined),
  statusCode: z.number().int().min(100).max(599).optional().catch(undefined),
  grpcCode: z.number().int().optional().catch(undefined),
  code: z.union([z.number(), z.string().regex(/^[\w-]{1,64}$/)]).optional().catch(undefined),
  response: z.object({status: z.number().optional()}).optional().catch(undefined),
});
export const lookupSchema = z.object({
  result: z.enum(["not-found", "terminal", "present", "unavailable"]),
  checkedAt: z.string(), method: z.string(),
  httpStatus: z.number().optional(), nativeCode: z.string().optional(), nativeState: z.string().optional(),
});
export type LookupEvidence = z.infer<typeof lookupSchema>;
const terminal = new Set(["deleted", "destroyed", "terminated"]);
function redact(value: string) {
  for (const [key, secret] of Object.entries(process.env))
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && secret && secret.length > 5) value = value.replaceAll(secret, "[REDACTED]");
  return value;
}

/** Only called on errors from an exact native lookup, never SDK metadata/connect errors. */
export function lookupError(error: unknown, name: string, method: string): LookupEvidence {
  const outer = statusFields.safeParse(error);
  const inner = statusFields.safeParse(error instanceof Error ? error.cause : undefined);
  const fields = [outer, inner].flatMap(v => v.success ? [v.data] : []);
  const statuses = fields.flatMap(v => [v.status, v.statusCode, v.response?.status].filter(v => v !== undefined));
  const codes = fields.flatMap(v => [v.code, ...(name === "boxd" ? [v.grpcCode] : [])]
    .flatMap(code => code === undefined ? [] : [String(code)]));
  const boxdMissing = name === "boxd" && typeof boxdNotFound === "function" && error instanceof boxdNotFound
    && outer.success && outer.data.grpcCode === 5 && codes.every(code => code === "5");
  const consistentGrpc = name !== "boxd" || !fields.some(v => v.grpcCode !== undefined) || boxdMissing;
  const absent = consistentGrpc && (statuses.length ? statuses.every(v => v === 404)
    : boxdMissing || name === "tenki" && codes.length > 0 && codes.every(v => v === "5"));
  return {result: absent ? "not-found" : "unavailable", method, checkedAt: new Date().toISOString(),
    ...(statuses[0] === undefined ? {} : {httpStatus: statuses[0]}), ...(codes[0] === undefined ? {} : {nativeCode: redact(codes[0])})};
}
const fn = z.custom<(...args: unknown[]) => Promise<unknown>>(v => typeof v === "function");
const ctor = z.custom<new (options?: unknown) => unknown>(v => typeof v === "function");
function member(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) throw new Error("Invalid native client");
  return Reflect.get(value, key);
}
async function call(value: unknown, key: string, ...args: unknown[]) {return fn.parse(member(value, key)).apply(value, args);}
async function sdk(name: string): Promise<unknown> {
  return import(import.meta.resolve(name, new URL("../../packages/sdk/package.json", import.meta.url).href));
}
// Match the installed native class, never an error name/message or an arbitrary gRPC-shaped object.
const boxdNotFound = member(await import(createRequire(new URL("../../packages/sdk/package.json", import.meta.url)).resolve("@boxd-sh/sdk")), "NotFoundError");
export const nativeModules = {load: sdk};
async function client(pkg: string, key: string, options?: unknown) {return new (ctor.parse(member(await nativeModules.load(pkg), key)))(options);}

/** Exact, read-only native lookup. No guest setup, connect/activate, resume or delete. */
export async function lookupSandbox(provider: Provider, id: string, timeoutMs: number): Promise<LookupEvidence> {
  const name = provider.name;
  const method = `${name}:native-exact-get`;
  try {
    const raw = await deadline(timeoutMs, async signal => {
      if (name === "memory") return provider.connect(id); // Memory connect only reads its machine map.
      const keys: Record<string, string> = {tenki: "TENKI_API_KEY", upstash: "UPSTASH_BOX_API_KEY", e2b: "E2B_API_KEY", daytona: "DAYTONA_API_KEY", boxd: "BOXD_API_KEY", boat: "BOAT_API_KEY", freestyle: "FREESTYLE_API_KEY", superserve: "SUPERSERVE_API_KEY"};
      const key = keys[name];
      if (key && !process.env[key]) throw new Error("Native lookup credentials unavailable");
      switch (name) {
        case "tenki": return call(await client("@tenkicloud/sandbox", "TenkiSandbox", {authToken: process.env.TENKI_API_KEY}), "get", id);
        case "upstash": {
          const box = await call(member(await nativeModules.load("@upstash/box"), "Box"), "get", id);
          if (member(box, "id") !== id) throw new Error("Native lookup ID mismatch");
          return {id, ...z.object({status: z.string()}).parse(await call(box, "getStatus"))};
        }
        case "e2b": {
          const mod = await nativeModules.load("e2b");
          try { return await call(member(mod, "Sandbox"), "getInfo", id, {apiKey: process.env.E2B_API_KEY}); }
          catch (error) {
            const NotFound = member(mod, "SandboxNotFoundError");
            if (typeof NotFound === "function" && error instanceof NotFound) throw Object.assign(new Error("Native sandbox not found"), {status: 404});
            throw error;
          }
        }
        case "daytona": {
          // Daytona.get also hydrates the toolbox URL. A missing toolbox is not a missing sandbox.
          const daytona = await client("@daytonaio/sdk", "Daytona");
          return member(await call(member(daytona, "sandboxApi"), "getSandbox", id), "data");
        }
        case "boxd": return call(member(await client("@boxd-sh/sdk", "Boxd", {apiKey: process.env.BOXD_API_KEY}), "machines"), "get", id);
        case "freestyle": return call(member(await client("freestyle", "Freestyle", {apiKey: process.env.FREESTYLE_API_KEY}), "vms"), "get", id);
        case "boat": {
          const mod = await nativeModules.load("@boatdev/sdk");
          const config = new (ctor.parse(member(mod, "Configuration")))({accessToken: process.env.BOAT_API_KEY, basePath: process.env.BOAT_API_BASE ?? "https://boat.dev/api/v1", fetchApi: (url: string, init?: RequestInit) => fetch(url, {...init, signal})});
          return member(await call(new (ctor.parse(member(mod, "BoatApi")))(config), "get", {sandboxId: id}), "sandbox");
        }
        case "superserve": {
          // Sandbox.connect POSTs /activate; use the SDK's read-only getInfo endpoint directly.
          const response = await fetch(`${process.env.SUPERSERVE_BASE_URL ?? "https://api.superserve.ai"}/sandboxes/${encodeURIComponent(id)}`, {headers: {"X-API-Key": process.env.SUPERSERVE_API_KEY ?? ""}, signal});
          if (!response.ok) throw Object.assign(new Error("Native lookup failed"), {status: response.status});
          return response.json();
        }
        case "local": return call(member(provider.native(id), "client"), "call", "GET", `/containers/${encodeURIComponent(id)}/json`);
        default: throw new Error("Native lookup unavailable");
      }
    });
    const info = z.object({id: z.string().optional(), Id: z.string().optional(), sandboxId: z.string().optional(), state: z.string().optional(), status: z.string().optional()}).parse(raw);
    if ((info.id ?? info.Id ?? info.sandboxId) !== id) throw new Error("Native lookup ID mismatch");
    const state = z.string().regex(/^[\w-]{1,64}$/).safeParse(info.state ?? info.status);
    return {result: state.success && terminal.has(state.data.toLowerCase()) ? "terminal" : "present", checkedAt: new Date().toISOString(), method,
      ...(state.success ? {nativeState: redact(state.data)} : {})};
  } catch (error) {
    if (name === "memory" && error && typeof error === "object" && "code" in error && error.code === "not_found")
      return {result: "not-found", checkedAt: new Date().toISOString(), method};
    return lookupError(error, name, method);
  }
}
export function isAbsent(evidence: LookupEvidence) {return evidence.result === "not-found" || evidence.result === "terminal";}

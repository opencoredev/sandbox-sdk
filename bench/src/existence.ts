import { z } from "zod";
import { createRequire } from "node:module";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import {
  call,
  construct,
  member,
  nativeSchema,
  optionalNativeClass,
  type NativeArgument,
} from "./native.js";
import { deadline } from "./timing.js";

const statusFields = z.object({
  status: z.number().int().min(100).max(599).optional().catch(undefined),
  statusCode: z.number().int().min(100).max(599).optional().catch(undefined),
  grpcCode: z.number().int().optional().catch(undefined),
  code: z
    .union([z.number(), z.string().regex(/^[\w-]{1,64}$/)])
    .optional()
    .catch(undefined),
  response: z.object({ status: z.number().optional() }).optional().catch(undefined),
});

export const lookupSchema = z.object({
  result: z.enum(["not-found", "terminal", "present", "unavailable"]),
  checkedAt: z.string(),
  method: z.string(),
  httpStatus: z.number().optional(),
  nativeCode: z.string().optional(),
  nativeState: z.string().optional(),
});

export type LookupEvidence = z.infer<typeof lookupSchema>;

const terminal = new Set(["deleted", "destroyed", "terminated"]);

function redact(value: string) {
  for (const [key, secret] of Object.entries(process.env))
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(key) && secret && secret.length > 5)
      value = value.replaceAll(secret, "[REDACTED]");

  return value;
}

/** Only called on errors from an exact native lookup, never SDK metadata/connect errors. */
export function lookupError(cause: unknown, name: string, method: string): LookupEvidence {
  const outer = statusFields.safeParse(cause);
  const inner = statusFields.safeParse(cause instanceof Error ? cause.cause : undefined);
  const fields = [outer, inner].flatMap((v) => (v.success ? [v.data] : []));

  const statuses = fields.flatMap((v) =>
    [v.status, v.statusCode, v.response?.status].filter((v) => v !== undefined),
  );

  const codes = fields.flatMap((v) =>
    [v.code, ...(name === "boxd" ? [v.grpcCode] : [])].flatMap((code) =>
      code === undefined ? [] : [String(code)],
    ),
  );

  const boxdMissing =
    name === "boxd" &&
    boxdNotFound !== undefined &&
    cause instanceof boxdNotFound &&
    outer.success &&
    outer.data.grpcCode === 5 &&
    codes.every((code) => code === "5");

  const consistentGrpc =
    name !== "boxd" || !fields.some((v) => v.grpcCode !== undefined) || boxdMissing;

  const absent =
    consistentGrpc &&
    (statuses.length
      ? statuses.every((v) => v === 404)
      : boxdMissing || (name === "tenki" && codes.length > 0 && codes.every((v) => v === "5")));

  const evidence: LookupEvidence = {
    result: absent ? "not-found" : "unavailable",
    method,
    checkedAt: new Date().toISOString(),
  };

  if (statuses[0] !== undefined) evidence.httpStatus = statuses[0];

  if (codes[0] !== undefined) evidence.nativeCode = redact(codes[0]);

  return evidence;
}

async function sdk(name: string): Promise<object> {
  return import(
    import.meta.resolve(name, new URL("../../packages/sdk/package.json", import.meta.url).href)
  );
}

// Match the installed native class, never an error name/message or an arbitrary gRPC-shaped object.
const boxdNotFound = member(
  nativeSchema.parse(
    await import(
      createRequire(new URL("../../packages/sdk/package.json", import.meta.url)).resolve(
        "@boxd-sh/sdk",
      )
    ),
  ),
  "NotFoundError",
  optionalNativeClass,
);

export const nativeModules = { load: sdk };

/** Load an installed native SDK through `nativeModules`, which tests replace. */
export async function loadNative(name: string) {
  return nativeSchema.parse(await nativeModules.load(name));
}

async function client(pkg: string, key: string, options?: NativeArgument) {
  return construct(await loadNative(pkg), key, options);
}

const lookupKeys = new Map([
  ["tenki", "TENKI_API_KEY"],
  ["upstash", "UPSTASH_BOX_API_KEY"],
  ["e2b", "E2B_API_KEY"],
  ["daytona", "DAYTONA_API_KEY"],
  ["boxd", "BOXD_API_KEY"],
  ["boat", "BOAT_API_KEY"],
  ["freestyle", "FREESTYLE_API_KEY"],
  ["superserve", "SUPERSERVE_API_KEY"],
]);

const nativeInfo = z.object({
  id: z.string().optional(),
  Id: z.string().optional(),
  sandboxId: z.string().optional(),
  state: z.string().optional(),
  status: z.string().optional(),
});

const memoryNotFound = z.object({ code: z.literal("not_found") });

/** Exact, read-only native lookup. No guest setup, connect/activate, resume or delete. */
export async function lookupSandbox(
  provider: Provider,
  id: string,
  timeoutMs: number,
): Promise<LookupEvidence> {
  const name = provider.name;
  const method = `${name}:native-exact-get`;

  try {
    const info = await deadline(timeoutMs, async (signal) => {
      // Memory connect only reads its machine map.
      if (name === "memory") return nativeInfo.parse(await provider.connect(id));

      const key = lookupKeys.get(name);

      if (key && !process.env[key]) throw new Error("Native lookup credentials unavailable");

      switch (name) {
        case "tenki":
          return call(
            await client("@tenkicloud/sandbox", "TenkiSandbox", {
              authToken: process.env.TENKI_API_KEY,
            }),
            "get",
            [id],
            nativeInfo,
          );
        case "upstash": {
          const box = await call(
            member(await loadNative("@upstash/box"), "Box", nativeSchema),
            "get",
            [id],
            nativeSchema,
          );

          if (box.id !== id) throw new Error("Native lookup ID mismatch");

          const { status } = await call(box, "getStatus", [], z.object({ status: z.string() }));

          return { id, status };
        }

        case "e2b": {
          const mod = await loadNative("e2b");

          try {
            return await call(
              member(mod, "Sandbox", nativeSchema),
              "getInfo",
              [id, { apiKey: process.env.E2B_API_KEY }],
              nativeInfo,
            );
          } catch (error) {
            const NotFound = member(mod, "SandboxNotFoundError", optionalNativeClass);

            if (NotFound !== undefined && error instanceof NotFound)
              throw Object.assign(new Error("Native sandbox not found"), { status: 404 });
            throw error;
          }
        }

        case "daytona": {
          // Daytona.get also hydrates the toolbox URL. A missing toolbox is not a missing sandbox.
          const daytona = await client("@daytonaio/sdk", "Daytona");
          const sandboxApi = member(daytona, "sandboxApi", nativeSchema);
          const response = await call(sandboxApi, "getSandbox", [id], nativeSchema);

          return member(response, "data", nativeInfo);
        }

        case "boxd": {
          const boxd = await client("@boxd-sh/sdk", "Boxd", { apiKey: process.env.BOXD_API_KEY });

          return call(member(boxd, "machines", nativeSchema), "get", [id], nativeInfo);
        }

        case "freestyle": {
          const freestyle = await client("freestyle", "Freestyle", {
            apiKey: process.env.FREESTYLE_API_KEY,
          });

          return call(member(freestyle, "vms", nativeSchema), "get", [id], nativeInfo);
        }

        case "boat": {
          const mod = await loadNative("@boatdev/sdk");

          const config = construct(mod, "Configuration", {
            accessToken: process.env.BOAT_API_KEY,
            basePath: process.env.BOAT_API_BASE ?? "https://boat.dev/api/v1",
            fetchApi: (url: string, init?: RequestInit) => fetch(url, { ...init, signal }),
          });

          const api = construct(mod, "BoatApi", config);
          const response = await call(api, "get", [{ sandboxId: id }], nativeSchema);

          return member(response, "sandbox", nativeInfo);
        }

        case "superserve": {
          // Sandbox.connect POSTs /activate; use the SDK's read-only getInfo endpoint directly.
          const response = await fetch(
            `${process.env.SUPERSERVE_BASE_URL ?? "https://api.superserve.ai"}/sandboxes/${encodeURIComponent(id)}`,
            { headers: { "X-API-Key": process.env.SUPERSERVE_API_KEY ?? "" }, signal },
          );

          if (!response.ok)
            throw Object.assign(new Error("Native lookup failed"), { status: response.status });

          return nativeInfo.parse(await response.json());
        }

        case "local":
          return call(
            member(nativeSchema.parse(provider.native(id)), "client", nativeSchema),
            "call",
            ["GET", `/containers/${encodeURIComponent(id)}/json`],
            nativeInfo,
          );
        default:
          throw new Error("Native lookup unavailable");
      }
    });

    if ((info.id ?? info.Id ?? info.sandboxId) !== id) throw new Error("Native lookup ID mismatch");

    const state = z
      .string()
      .regex(/^[\w-]{1,64}$/)
      .safeParse(info.state ?? info.status);

    const evidence: LookupEvidence = {
      result: state.success && terminal.has(state.data.toLowerCase()) ? "terminal" : "present",
      checkedAt: new Date().toISOString(),
      method,
    };

    if (state.success) evidence.nativeState = redact(state.data);

    return evidence;
  } catch (error) {
    if (name === "memory" && memoryNotFound.safeParse(error).success)
      return { result: "not-found", checkedAt: new Date().toISOString(), method };

    return lookupError(error, name, method);
  }
}

export function isAbsent(evidence: LookupEvidence) {
  return evidence.result === "not-found" || evidence.result === "terminal";
}

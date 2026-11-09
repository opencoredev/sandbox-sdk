import { z } from "zod";
import { createRequire } from "node:module";
import type { BoatApi, Configuration } from "@boatdev/sdk";
import type { Boxd } from "@boxd-sh/sdk";
import type { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import type { LocalNative } from "@opencoredev/sandbox-sdk/local";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import type { Snapshot } from "@superserve/sdk";
import type { TenkiSandbox } from "@tenkicloud/sandbox";
import type { Box } from "@upstash/box";
import type { Sandbox, SnapshotListOpts, SnapshotPaginator } from "e2b";
import type { Freestyle } from "freestyle";
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

/**
 * The parts of each native SDK the bench calls, typed by the SDK itself: the installed module, or
 * a test fake.
 */
export interface NativeModules {
  e2b: {
    Sandbox: Pick<typeof Sandbox, "getInfo" | "deleteSnapshot"> & {
      listSnapshots(opts?: SnapshotListOpts): Pick<SnapshotPaginator, "hasNext" | "nextItems">;
    };
    SandboxNotFoundError: abstract new (...args: never[]) => Error;
  };
  "@daytonaio/sdk": {
    Daytona: new (...args: ConstructorParameters<typeof Daytona>) => {
      readonly snapshot: Pick<Daytona["snapshot"], "get" | "list" | "delete">;
      get(...args: Parameters<Daytona["get"]>): Promise<Pick<DaytonaSandbox, "createSnapshot">>;
    };
  };
  "@upstash/box": { Box: Pick<typeof Box, "get" | "deleteSnapshots"> };
  "@boatdev/sdk": {
    Configuration: new (...args: ConstructorParameters<typeof Configuration>) => Configuration;
    BoatApi: new (...args: ConstructorParameters<typeof BoatApi>) => Pick<BoatApi, "get">;
  };
  "@boxd-sh/sdk": {
    Boxd: new (...args: ConstructorParameters<typeof Boxd>) => {
      readonly machines: Pick<Boxd["machines"], "get">;
      readonly snapshots: Pick<Boxd["snapshots"], "get" | "delete">;
    };
  };
  freestyle: {
    Freestyle: new (...args: ConstructorParameters<typeof Freestyle>) => {
      readonly vms: Pick<Freestyle["vms"], "get"> & {
        readonly snapshots: Pick<Freestyle["vms"]["snapshots"], "get" | "delete">;
      };
    };
  };
  "@tenkicloud/sandbox": {
    TenkiSandbox: new (
      ...args: ConstructorParameters<typeof TenkiSandbox>
    ) => Pick<TenkiSandbox, "get" | "getSnapshot" | "deleteSnapshot">;
  };
  "@superserve/sdk": { Snapshot: Pick<typeof Snapshot, "get" | "list" | "deleteById"> };
  /** Modal's client: reads MODAL_TOKEN_ID and MODAL_TOKEN_SECRET from the environment. */
  modal: {
    ModalClient: new () => {
      readonly images: {
        fromId(imageId: string): Promise<{ readonly imageId: string }>;
        delete(imageId: string): Promise<void>;
      };
      readonly sandboxes: {
        /** Makes no request; `poll` is the exact read. */
        fromId(sandboxId: string): Promise<{
          readonly sandboxId: string;
          /** The exit code once the sandbox has finished, else null. */
          poll(): Promise<number | null>;
        }>;
      };
      /**
       * Modal's control-plane client. `workspaceBillingReport` is the call behind the documented
       * `modal billing report` (https://modal.com/docs/reference/cli/billing); Modal's JS SDK marks
       * the client `@ignore`. It streams one item per App and interval.
       */
      readonly cpClient: {
        workspaceBillingReport(request: {
          startTimestamp: Date;
          endTimestamp: Date;
          resolution: string;
          tagNames: string[];
          environmentIds: string[];
          appIds: string[];
        }): AsyncIterable<object>;
      };
      close(): void;
    };
    NotFoundError: abstract new (...args: never[]) => Error;
  };
  /**
   * The gRPC client library Modal's SDK uses, resolved from Modal's own install so `instanceof`
   * matches the errors it throws. Modal answers a lookup of an unknown sandbox with NOT_FOUND.
   */
  "nice-grpc": {
    ClientError: abstract new (...args: never[]) => Error & { readonly code: number };
    Status: { readonly NOT_FOUND: number };
  };
}

/** The installed SDKs. Each must satisfy its `NativeModules` entry, which `sdk` checks. */
interface InstalledModules {
  e2b: typeof import("e2b");
  "@daytonaio/sdk": typeof import("@daytonaio/sdk");
  "@upstash/box": typeof import("@upstash/box");
  "@boatdev/sdk": typeof import("@boatdev/sdk");
  "@boxd-sh/sdk": typeof import("@boxd-sh/sdk");
  freestyle: typeof import("freestyle");
  "@tenkicloud/sandbox": typeof import("@tenkicloud/sandbox");
  "@superserve/sdk": typeof import("@superserve/sdk");
  // `modal` is an SDK dependency the bench cannot resolve types for; the slice above is hand-typed
  // from modal 0.11.1 and checked by the live snapshot run.
  modal: NativeModules["modal"];
  // Modal's dependency, resolved next to it; hand-typed from nice-grpc 2.
  "nice-grpc": NativeModules["nice-grpc"];
}

type NativePackage = keyof NativeModules;

const sdkPackage = new URL("../../packages/sdk/package.json", import.meta.url);

// Resolve from the SDK package so the bench shares the adapters' module instances.
async function sdk<P extends NativePackage>(name: P): Promise<NativeModules[P]> {
  // nice-grpc is Modal's dependency, not the SDK's: resolve it from Modal's install.
  const parent =
    name === "nice-grpc" ? import.meta.resolve("modal", sdkPackage.href) : sdkPackage.href;

  const installed: InstalledModules[P] = await import(import.meta.resolve(name, parent));

  return installed;
}

// Match the installed native class, never an error name/message or an arbitrary gRPC-shaped object.
const { NotFoundError: boxdNotFound }: typeof import("@boxd-sh/sdk") = await import(
  createRequire(sdkPackage).resolve("@boxd-sh/sdk")
);

/** Loads installed native SDKs; tests replace `load`. */
export const nativeModules = { load: sdk };

/** `local().native(id)`: the adapter's handle on its Docker container. */
type LocalHandle = { readonly client: Pick<LocalNative["client"], "call"> };

/**
 * Whether a native handle is the local adapter's. `Provider` erases the handle's type, so this
 * checks the one member the bench calls.
 */
function isLocalHandle(handle: unknown): handle is LocalHandle {
  return (
    typeof handle === "object" &&
    handle !== null &&
    "client" in handle &&
    typeof handle.client === "object" &&
    handle.client !== null &&
    "call" in handle.client &&
    typeof handle.client.call === "function"
  );
}

/** The Docker client behind a local sandbox. */
export function localDocker(provider: Provider, id: string) {
  const handle = provider.native(id);

  if (!isLocalHandle(handle)) throw new Error("Local native handle unavailable");

  return handle.client;
}

/** The one read the bench makes on Daytona's generated sandbox API; its response is decoded. */
type DaytonaSandboxApi = { getSandbox(id: string): Promise<object> };

/** Whether a value is Daytona's sandbox API. The SDK declares that field private and untyped. */
function isDaytonaSandboxApi(api: unknown): api is DaytonaSandboxApi {
  return (
    typeof api === "object" &&
    api !== null &&
    "getSandbox" in api &&
    typeof api.getSandbox === "function"
  );
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
  ["modal", "MODAL_TOKEN_SECRET"],
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
        case "tenki": {
          const { TenkiSandbox } = await nativeModules.load("@tenkicloud/sandbox");
          const tenki = new TenkiSandbox({ authToken: process.env.TENKI_API_KEY });

          return nativeInfo.parse(await tenki.get(id));
        }

        case "upstash": {
          const { Box } = await nativeModules.load("@upstash/box");
          const box = await Box.get(id);

          if (box.id !== id) throw new Error("Native lookup ID mismatch");

          const { status } = z.object({ status: z.string() }).parse(await box.getStatus());

          return { id, status };
        }

        case "e2b": {
          const { Sandbox, SandboxNotFoundError } = await nativeModules.load("e2b");

          try {
            return nativeInfo.parse(await Sandbox.getInfo(id, { apiKey: process.env.E2B_API_KEY }));
          } catch (error) {
            if (error instanceof SandboxNotFoundError)
              throw Object.assign(new Error("Native sandbox not found"), { status: 404 });
            throw error;
          }
        }

        case "daytona": {
          const { Daytona } = await nativeModules.load("@daytonaio/sdk");
          const daytona = new Daytona();

          // Daytona.get also hydrates the toolbox URL. A missing toolbox is not a missing sandbox.
          const sandboxApi = "sandboxApi" in daytona ? daytona.sandboxApi : undefined;

          if (!isDaytonaSandboxApi(sandboxApi)) throw new Error("Daytona sandbox API unavailable");

          const response = z.object({ data: nativeInfo }).parse(await sandboxApi.getSandbox(id));

          return response.data;
        }

        case "boxd": {
          const { Boxd } = await nativeModules.load("@boxd-sh/sdk");
          const boxd = new Boxd({ apiKey: process.env.BOXD_API_KEY });

          return nativeInfo.parse(await boxd.machines.get(id));
        }

        case "freestyle": {
          const { Freestyle } = await nativeModules.load("freestyle");
          const freestyle = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });

          return nativeInfo.parse(await freestyle.vms.get(id));
        }

        case "boat": {
          const { BoatApi, Configuration } = await nativeModules.load("@boatdev/sdk");

          const config = new Configuration({
            accessToken: process.env.BOAT_API_KEY,
            basePath: process.env.BOAT_API_BASE ?? "https://boat.dev/api/v1",
            fetchApi: (url: string, init?: RequestInit) => fetch(url, { ...init, signal }),
          });

          const response = await new BoatApi(config).get({ sandboxId: id });

          return nativeInfo.parse(response.sandbox);
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

        case "modal": {
          const { ModalClient } = await nativeModules.load("modal");
          const { ClientError, Status } = await nativeModules.load("nice-grpc");
          const client = new ModalClient();

          try {
            // fromId makes no request; poll is one exact read: null while it runs, else its exit.
            const sandbox = await client.sandboxes.fromId(id);
            const exit = await sandbox.poll();

            return { id: sandbox.sandboxId, status: exit === null ? "running" : "terminated" };
          } catch (error) {
            // Only Modal's NOT_FOUND is absence. A malformed ID is INVALID_ARGUMENT, and any
            // transport or auth failure stays unavailable.
            if (error instanceof ClientError && error.code === Status.NOT_FOUND)
              throw Object.assign(new Error("Native sandbox not found"), { status: 404 });
            throw error;
          } finally {
            client.close();
          }
        }

        case "local": {
          const docker = localDocker(provider, id);

          return nativeInfo.parse(
            await docker.call("GET", `/containers/${encodeURIComponent(id)}/json`),
          );
        }

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

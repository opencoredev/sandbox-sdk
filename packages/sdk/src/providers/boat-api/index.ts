/** Official sources. Routes, headers and bodies match @boatdev/sdk 1.9.9, which this adapter no longer loads:
 * https://boat.dev
 * https://docs.boat.dev/api/v1
 * https://docs.boat.dev/sdks/typescript
 * https://docs.boat.dev/api/reference/sandboxes/update-sandbox
 * https://docs.boat.dev/long-running-tasks/background-commands
 * https://docs.boat.dev/machines
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { posix } from "node:path";
import type { Provider, CreateInput, SandboxInfo, Labels, FileInfo } from "../../provider.js";
import { createNativeApi, sdkCall, sdkConstruct, type NativeApi, type NativeSdkBinding } from "../../native.js";
import { execute, fileChunkBytes, quote, stage, workspace } from "./exec.js";
import type { BoatOptions, BoatNative, BoatClientSdk, BoatSandboxSdk } from "../boat/index.js";
import { errors } from "./errors.js";
import { boatHttp, command, parseSandboxBody, parseSandboxPage, writeFile, type BoatHttp, type BoatPlane, type BoatSandbox } from "./transport.js";
export interface BoatApiSettings {
  name: string;
  label: string;
  keyEnv: string;
  baseUrl: string;
  baseEnv?: string;
  createFrom?: boolean;
  /** Maps idleTimeoutMs to the native idleStopMinutes create field. */
  idleStop?: boolean;
  pausedStates?: readonly string[];
  downloadMaxBytes?: number;
  /** Extra create body fields, such as Sandboxer's region. */
  createFields?: Readonly<Record<string, unknown>>;
  /** Sees every sandbox the API returns, such as Sandboxer recording regions. */
  observe?: (sandbox: BoatSandbox) => void;
  destroy?: (http: BoatHttp, id: string) => Promise<void>;
  download?: (http: BoatHttp, id: string, path: string) => Promise<Uint8Array>;
  preview?: (url: string) => Promise<{ url: string; headers?: Record<string, string> }>;
  /** Extra `Configuration` parameters for the client `native.sdk()` builds. */
  sdkConfiguration?: Readonly<Record<string, unknown>>;
}
const defaults: BoatApiSettings = { name: "boat", label: "Boat", keyEnv: "BOAT_API_KEY", baseEnv: "BOAT_API_BASE", baseUrl: "https://boat.dev/api/v1" };
const sdkPackage = "@boatdev/sdk";
const prefix = "sandbox-sdk:1:";
const own = { "sandbox-sdk": "1" };
const presets = { small: "small", medium: "default", large: "large" } satisfies Record<
  string,
  "small" | "default" | "large"
>;

// Boat has no labels. Keep metadata in its display name so stopped VMs remain
// discoverable. Never allow the API's silent 120-character truncation.
function metadataName(input: CreateInput, failure: ReturnType<typeof errors>["failure"], label: string) {
  const labels = { ...input.labels };
  delete labels["sandbox-sdk"];
  const json = JSON.stringify([input.key ?? null, labels]);
  if (Buffer.byteLength(json) > 65_536)
    throw failure("Key and labels exceed the metadata size limit", "unsupported");
  const name = prefix + deflateRawSync(json).toString("base64url");
  if (name.length > 120)
    throw failure(`Key and labels exceed ${label}'s encoded name budget; shorten them`, "unsupported");
  return name;
}
function metadata(name: string): { key?: string; labels: Labels } | undefined {
  if (!name.startsWith(prefix)) return;
  try {
    const value: unknown = JSON.parse(
      inflateRawSync(Buffer.from(name.slice(prefix.length), "base64url"), {
        maxOutputLength: 65_536,
      }).toString(),
    );
    if (!Array.isArray(value) || value.length !== 2) return;
    const [key, raw]: unknown[] = value;
    if (key !== null && typeof key !== "string") return;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const labels: Labels = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "string") return;
      Object.defineProperty(labels, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { ...(key === null ? {} : { key }), labels: { ...labels, ...own } };
  } catch {
    return;
  }
}
function info(raw: BoatSandbox, failure: ReturnType<typeof errors>["failure"], label: string, pausedStates: readonly string[] = []): SandboxInfo {
  const data = metadata(raw.name);
  if (!data)
    throw failure(
      "Sandbox has no valid SDK metadata; connect an SDK-created sandbox",
      "not_found",
      raw.id,
    );
  const createdAt = raw.createdAt;
  if (!Number.isFinite(createdAt))
    throw failure(`${label} returned no valid creation timestamp`, "provider", raw.id);
  return {
    id: raw.id,
    ...data,
    createdAt,
    state: pausedStates.includes(raw.state) ? "paused" : ["ready", "idle", "running"].includes(raw.state) ? "running" : "stopped",
  };
}
function fileInfo(value: unknown, failure: ReturnType<typeof errors>["failure"], label: string): FileInfo {
  if (
    typeof value !== "object" ||
    value === null ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("type" in value) ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !("modifiedAt" in value) ||
    typeof value.modifiedAt !== "number"
  )
    throw failure(`Invalid file metadata from ${label}`);
  const type = value.type;
  if (type !== "file" && type !== "directory" && type !== "symlink")
    throw failure(`Invalid file type from ${label}`);
  return { path: value.path, type, size: value.size, modifiedAt: value.modifiedAt };
}
const statScript = `const fs=require('fs'),p=require('path');const stat=x=>{const s=fs.lstatSync(x);return {path:x,type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':'file',size:s.size,modifiedAt:s.mtimeMs}};`;


/** The adapter and the HTTP client it shares with `box.native`, `provider.api` and Sandboxer's extra calls. */
export interface BoatCore {
  provider: Provider<BoatNative, "size"> & { readonly api: NativeApi<BoatPlane, BoatClientSdk> };
  http: BoatHttp;
}

/** Boat API v1 over plain HTTP, with no installed remote agent or local daemon. */
export function boatApi(options: BoatOptions = {}, settings: BoatApiSettings = defaults): BoatCore {
  const { failure, boatError } = errors(settings.name, settings.label, settings.keyEnv, settings.name !== "boat");
  const label = settings.label;
  const environmentFiles = new Map<string, Map<string, Promise<string>>>();
  const environments = new Map<string, Record<string, string>>();
  const timeoutMs = options.requestTimeoutMs ?? 90_000;
  const key = () => options.apiKey ?? process.env[settings.keyEnv];
  // Read on first use, not at construction, so a missing key or bad option fails the first call.
  function credentials() {
    const value = key();
    if (!value) throw failure(`${label} API key is missing. Authentication is required. Set ${settings.keyEnv} or pass apiKey.`, "auth");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");
    return value;
  }
  const transport = {
    provider: settings.name, label, keyEnv: settings.keyEnv,
    baseUrl: () => options.baseUrl ?? options.apiUrl ?? (settings.baseEnv ? process.env[settings.baseEnv] : undefined) ?? settings.baseUrl,
    credentials, secrets: () => [key()],
    timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 90_000,
  };
  const http = boatHttp(transport);
  // Create makes its own attempts, and the command follower its own reconnects, so their client never
  // retries underneath them. A first attach that fails then fails fast, so the command is stopped at once.
  const once = boatHttp({ ...transport, retries: 0 });
  const sandboxOf = (value: unknown) => {
    const sandbox = parseSandboxBody(value, settings.name, label);
    settings.observe?.(sandbox);
    return sandbox;
  };
  async function safe<T>(action: () => Promise<T>, id?: string): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw boatError(error, id);
    }
  }
  async function raw(id: string, script: string, file = false, prepare = false) {
    const result = await command(http, id, { command: prepare ? `${workspace}; ${script}` : script, timeoutSeconds: 60 });
    if (result.kind !== "finished")
      throw failure(`${label} returned an unexpected detached result`, "outcome_unknown", id);
    if (result.truncated)
      throw failure(
        `${label} truncated operation output; no partial file data was returned`,
        "provider",
        id,
      );
    if (result.exitCode !== 0)
      throw failure(
        file && result.exitCode === 44
          ? "File does not exist"
          : `${label} file or setup operation failed`,
        file && result.exitCode === 44 ? "file_not_found" : "provider",
        id,
      );
    return result.stdout;
  }
  // Directory/stat operations use the documented command API, not invented endpoints.
  const node = (id: string, script: string, args: string[] = []) =>
    safe(
      () =>
        raw(
          id,
          `node -e ${quote(`try {${script}} catch(e) {process.exit(e.code==='ENOENT'?44:45)}`)} ${args.map(quote).join(" ")}`,
          true,
          args.some(path => path === "/workspace" || path.startsWith("/workspace/")),
        ),
      id,
    );
  async function readRange(id: string, path: string, offset: number, length: number) {
    const chunks: Buffer[] = [];
    for (let position = 0; position < length; position += 16_384) {
      const count = Math.min(16_384, length - position);
      const text = await node(
        id,
        "const f=require('fs'),fd=f.openSync(process.argv[1],'r');try{const b=Buffer.alloc(Number(process.argv[3]));const n=f.readSync(fd,b,0,b.length,Number(process.argv[2]));process.stdout.write(b.subarray(0,n).toString('base64'))}finally{f.closeSync(fd)}",
        [path, String(offset + position), String(count)],
      );
      const chunk = Buffer.from(text, "base64");
      chunks.push(chunk);
      if (chunk.length < count) break;
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  // `native.sdk()` builds the caller's own BoatApi client against the same base URL and key.
  const binding: NativeSdkBinding = {
    package: sdkPackage,
    async connect(module, sandboxId) {
      const configuration = sdkConstruct(module, "Configuration", [{ ...settings.sdkConfiguration, basePath: transport.baseUrl(), accessToken: credentials() }], sdkPackage);
      const client = sdkConstruct(module, "BoatApi", [configuration], sdkPackage);
      if (sandboxId === undefined) return client;
      const response = await sdkCall(client, "get", [{ sandboxId }], sdkPackage);
      return { client, sandbox: typeof response === "object" && response !== null ? Reflect.get(response, "sandbox") : undefined };
    },
  };
  const provider: BoatCore["provider"] = {
    name: settings.name,
    keyMode: "best-effort",
    capabilities: new Set(["size"]),
    create: (input) =>
      safe(async () => {
        if (input.network !== undefined && input.network !== "all")
          throw failure(`${label} network policy is unsupported by this adapter`, "unsupported");
        if (input.size !== undefined && typeof input.size !== "string")
          throw failure(
            `${label} supports small, medium and large presets; custom sizes are unavailable`,
            "unsupported",
          );
        if (input.timeoutMs !== undefined)
          throw failure(
            `${label} auto-stop archives the VM and restarts while its agent works, so it is not a hard lifetime; timeoutMs is unsupported. Set the provider's ttlSeconds option instead`,
            "unsupported",
          );
        if (input.idleTimeoutMs !== undefined && !settings.idleStop)
          throw failure(`${label} has no idle timer; idleTimeoutMs is unsupported`, "unsupported");
        const { ttlSeconds, snapshots, monitoring, org } = options;
        if (ttlSeconds !== undefined && ttlSeconds !== null && (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 2_592_000))
          throw failure("ttlSeconds must be null or an integer from 1 to 2592000", "invalid_argument");
        // Idle pause wakes on the next API call. It needs snapshots, and the
        // API takes whole minutes up to a week.
        let idleStopMinutes: number | undefined;
        if (input.idleTimeoutMs !== undefined) {
          idleStopMinutes = Math.ceil(input.idleTimeoutMs / 60_000);
          if (idleStopMinutes > 10_080) throw failure(`${label} idle pause is at most 7 days`, "invalid_argument");
          if (snapshots === false) throw failure(`${label} idle pause needs snapshots; drop idleTimeoutMs or snapshots: false`, "invalid_argument");
        }
        if (input.from !== undefined && !settings.createFrom)
          throw failure(`${label} snapshots are not supported by this adapter`, "unsupported");
        const name = metadataName(input, failure, label);
        if (input.signal?.aborted) throw failure("Creation was aborted", "aborted");
        const idempotencyKey = crypto.randomUUID();
        const body = {
          noEnv: true,
          ...(input.from === undefined ? {} : { from: input.from }),
          env: input.env,
          type: input.size === undefined ? (options.machine ?? options.type) : presets[input.size],
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          ...(snapshots === undefined ? {} : { snapshots }),
          ...(monitoring === undefined ? {} : { monitoring }),
          ...(org === undefined ? {} : { org }),
          ...(idleStopMinutes === undefined ? {} : { idleStopMinutes }),
          ...settings.createFields,
        };
        // A response may be lost after Boat accepts the VM. Retry only with the
        // same documented idempotency key and identical body, including on abort,
        // so a late VM can be recovered and destroyed below.
        let sandbox: BoatSandbox | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            sandbox = sandboxOf(await once.json({ method: "POST", path: "/sandboxes", body, idempotencyKey }));
            break;
          } catch (error) {
            const code = boatError(error).code;
            if (["auth", "invalid_argument", "quota", "not_found"].includes(code)) throw error;
            if (attempt === 2)
              throw failure(
                `${label} create outcome remains unknown; recover with idempotency key ${idempotencyKey} and the same request body within 24 hours`,
                "outcome_unknown",
              );
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
        if (!sandbox) throw failure(`${label} returned no sandbox after create`, "outcome_unknown");
        const id = sandbox.id;
        environments.set(id, { ...input.env });
        try {
          if (input.signal?.aborted) throw failure("Creation was aborted", "aborted");
          // Boat has no name at create. Preserve durable cross-client metadata;
          // its command API waits for provisioning when first use arrives early.
          const updated = sandboxOf(await http.json({ method: "PATCH", path: "/sandboxes/{sandboxId}", params: { sandboxId: id }, sandboxId: id, body: { name } }));
          if (input.signal?.aborted) throw failure("Creation was aborted", "aborted");
          if (updated.name !== name) return await provider.connect(id);
          return { ...info(updated, failure, label, settings.pausedStates), state: "running" } satisfies SandboxInfo;
        } catch (error) {
          await provider.destroy(id);
          throw error;
        }
      }),
    connect: (id) =>
      safe(async () => info(sandboxOf(await http.json({ method: "GET", path: "/sandboxes/{sandboxId}", params: { sandboxId: id }, sandboxId: id })), failure, label, settings.pausedStates), id),
    list: (labels) =>
      safe(async () => {
        const values: SandboxInfo[] = [];
        let cursor: string | undefined;
        const visited = new Set<string>();
        do {
          const page = parseSandboxPage(await http.json({ method: "GET", path: "/sandboxes", query: { limit: 200, cursor } }), settings.name, label);
          for (const sandbox of page.sandboxes) {
            settings.observe?.(sandbox);
            if (!metadata(sandbox.name)) continue;
            const value = info(sandbox, failure, label, settings.pausedStates);
            if (Object.entries(labels).every(([key, expected]) => value.labels[key] === expected)) values.push(value);
          }
          if (!page.hasMore) break;
          const next = page.nextCursor;
          if (!next || visited.has(next))
            throw failure(`${label} returned an invalid pagination cursor`);
          visited.add(next);
          cursor = next;
        } while (cursor !== undefined);
        return values;
      }),
    async find(key) {
      return (await provider.list({})).find((value) => value.key === key);
    },
    destroy: (id) =>
      safe(async () => {
        try {
          if (settings.destroy) await settings.destroy(http, id);
          else await http.request({ method: "DELETE", path: "/sandboxes/{sandboxId}", params: { sandboxId: id }, sandboxId: id, headers: { "X-Ascii-Confirm-Delete": id } });
        } catch (error) {
          if (boatError(error).code !== "not_found") throw error;
        }
        environments.delete(id);
        environmentFiles.delete(id);
      }, id),
    exec: (id, input) => safe(async () => {
      let files = environmentFiles.get(id);
      if (!files) { files = new Map(); environmentFiles.set(id, files); }
      return execute(http, id, input, environments.get(id), files, { failure, boatError }, { http: once });
    }, id),
    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,
      readRange: (id, path, range) => readRange(id, path, range.offset, range.length),
      read: async (id, path) => {
        // Open, measure and read small files in one guest operation. Following
        // the same fd preserves symlink behavior and bounds command output.
        const text = await node(id,
          "const f=require('fs'),fd=f.openSync(process.argv[1],'r');try{const size=f.fstatSync(fd).size,b=Buffer.alloc(Math.min(size,16384)),n=f.readSync(fd,b,0,b.length,0);process.stdout.write(size+'\\n'+b.subarray(0,n).toString('base64'))}finally{f.closeSync(fd)}",
          [path],
        );
        const separator = text.indexOf("\n");
        const size = Number(text.slice(0, separator));
        if (separator < 0 || !Number.isSafeInteger(size) || size < 0)
          throw failure(`Invalid ${label} file size`);
        const first = Buffer.from(text.slice(separator + 1), "base64");
        if (size <= 16_384) return new Uint8Array(first);
        if (size <= 1024 * 1024)
          return new Uint8Array(Buffer.concat([first, await readRange(id, path, first.length, size - first.length)]));
        if (settings.downloadMaxBytes !== undefined && size > settings.downloadMaxBytes)
          return new Uint8Array(Buffer.concat([first, await readRange(id, path, first.length, size - first.length)]));
        return safe(async () => {
          // Signed downloads have no size limit, but only accept /tmp or
          // /home/user paths. Snapshot the file into private staging first.
          const dir = `/tmp/.sandbox-sdk/download-${crypto.randomUUID()}`;
          const staged = `${dir}/file`;
          try {
            const copiedSize = Number(await node(id,
              "const f=require('fs');f.mkdirSync('/tmp/.sandbox-sdk',{recursive:true});f.mkdirSync(process.argv[2],{mode:0o700});f.copyFileSync(process.argv[1],process.argv[2]+'/file');process.stdout.write(String(f.statSync(process.argv[2]+'/file').size))",
              [path, dir],
            ));
            if (!Number.isSafeInteger(copiedSize) || copiedSize < 0) throw failure("Invalid staged file size", "provider", id);
            if (settings.download) {
              const bytes = await settings.download(http, id, staged);
              if (bytes.length !== copiedSize) throw failure("Incomplete artifact download", "provider", id);
              return bytes;
            }
            // Creating a link changes nothing, so a lost response is not an unknown outcome.
            const link: unknown = await http.json({ method: "POST", path: "/sandboxes/{sandboxId}/files/download-url", params: { sandboxId: id }, sandboxId: id, body: { path: staged, ttlSeconds: 300 }, readOnly: true });
            const url = typeof link === "object" && link !== null && "url" in link && typeof link.url === "string" ? link.url : undefined;
            if (!url) throw failure(`${label} returned no signed download URL`, "provider", id);
            // The URL carries its own signature: no account credentials, and errors never show it.
            let bytes: Uint8Array;
            try {
              bytes = (await http.request({ method: "GET", path: url, auth: false, sandboxId: id, maxBytes: copiedSize + 1 })).body;
            } catch (error) {
              const code = boatError(error, id).code;
              throw failure("Signed file download failed", code === "aborted" || code === "timeout" ? code : "unavailable", id);
            }
            if (bytes.length !== copiedSize) throw failure("Incomplete signed file download", "provider", id);
            return bytes;
          } finally {
            await node(id, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [dir]).catch(() => {});
          }
        }, id);
      },
      write: (id, path, data, options = {}) =>
        safe(async () => {
          const { mode } = options;
          if (mode !== undefined && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777))
            throw failure("mode must be an integer from 0 to 0o7777", "invalid_argument", id);
          const normalized = posix.normalize(path);
          // The API creates parents, but canonical paths outside these roots
          // are rejected. It cannot set a mode, so a mode always takes the
          // staged path below, which applies it before any bytes land.
          if (mode === undefined && data.length <= fileChunkBytes &&
              (normalized.startsWith("/home/user/") || normalized.startsWith("/tmp/"))) {
            try {
              await writeFile(http, id, { path, content: Buffer.from(data).toString("base64"), encoding: "base64" });
              return;
            } catch (error) {
              if (boatError(error).code !== "invalid_argument") throw error;
            }
          }
          // Stage the bytes in a fresh private directory through the file API,
          // then copy them into place. Writing through an opened descriptor
          // follows symlinks and keeps the target inode. Bytes never enter
          // command text. Copy and cleanup share a command.
          const dir = `/tmp/.sandbox-sdk/write-${crypto.randomUUID()}`;
          let cleaned = false;
          try {
            const parts = await stage(http, id, dir, data, failure);
            await node(id,
              "const f=require('fs'),[d,dir,n,m]=process.argv.slice(1);try{f.mkdirSync(require('path').dirname(d),{recursive:true});const fd=f.openSync(d,'w',m?0o600:0o666);try{if(m)f.fchmodSync(fd,Number(m));for(let i=0;i<Number(n);i++)f.writeFileSync(fd,f.readFileSync(dir+'/part-'+i))}finally{f.closeSync(fd)}}finally{f.rmSync(dir,{recursive:true,force:true})}",
              [path, dir, String(parts.length), mode === undefined ? "" : String(mode)],
            );
            cleaned = true;
          } finally {
            // Includes unknown upload outcomes (response lost after remote write).
            if (!cleaned) await node(id, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [dir]).catch(() => {});
          }
        }, id),
      stat: async (id, path) => {
        const value: unknown = JSON.parse(
          await node(
            id,
            statScript + "process.stdout.write(JSON.stringify(stat(process.argv[1])))",
            [path],
          ),
        );
        return fileInfo(value, failure, label);
      },
      list: async (id, path) => {
        const value: unknown = JSON.parse(
          await node(
            id,
            statScript +
              "process.stdout.write(JSON.stringify(fs.readdirSync(process.argv[1]).map(x=>stat(p.join(process.argv[1],x)))))",
            [path],
          ),
        );
        if (!Array.isArray(value)) throw failure(`Invalid ${label} directory listing`);
        return value.map(value => fileInfo(value, failure, label));
      },
      mkdir: async (id, path) => {
        await node(id, "require('fs').mkdirSync(process.argv[1],{recursive:true})", [path]);
      },
      remove: async (id, path, settings) => {
        await node(
          id,
          "require('fs').rmSync(process.argv[1],{recursive:process.argv[2]==='true'})",
          [path, String(settings.recursive)],
        );
      },
    },
    previewUrl: (id, port) =>
      safe(async () => {
        const result: unknown = await http.json({ method: "POST", path: "/sandboxes/{sandboxId}/host", params: { sandboxId: id }, sandboxId: id, body: { port } });
        if (typeof result !== "object" || result === null || !("url" in result) || typeof result.url !== "string" || !result.url)
          throw failure(`${label} returned no preview URL`, "provider", id);
        if (settings.preview) return settings.preview(result.url);
        const url = new URL(result.url);
        const token = url.searchParams.get("_token");
        // Boat exchanges this token for an identically valued _port_auth cookie
        // through a redirect. Server fetch has no browser cookie jar.
        if (token) {
          if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw failure("Invalid preview token", "provider", id);
          url.searchParams.delete("_token");
          return { url: url.toString(), headers: { Cookie: `_port_auth=${token}` } };
        }
        if (("isProtected" in result && result.isProtected === true) || ("access" in result && result.access === "private"))
          throw failure("Protected preview returned no token", "provider", id);
        return { url: url.toString() };
      }, id),
    native: (id) => createNativeApi<BoatPlane, BoatSandboxSdk>({ http, placeholder: "sandboxId", sandboxId: id, sdk: binding }),
    api: createNativeApi<BoatPlane, BoatClientSdk>({ http, placeholder: "sandboxId", sdk: binding }),
  };
  return { provider, http };
}

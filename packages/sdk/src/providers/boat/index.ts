/** Official sources, checked against @boatdev/sdk 1.9.9:
 * https://boat.dev
 * https://docs.boat.dev/api/v1
 * https://docs.boat.dev/sdks/typescript
 * https://docs.boat.dev/api/reference/sandboxes/update-sandbox
 * https://docs.boat.dev/long-running-tasks/background-commands
 * https://docs.boat.dev/machines
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { BoatApi, Sandbox as BoatSandbox } from "@boatdev/sdk";
import type { Provider, CreateInput, SandboxInfo, Labels, FileInfo } from "../../provider.js";
import { boatError, failure } from "./errors.js";
import { execute, quote } from "./exec.js";

export interface BoatOptions {
  apiKey?: string;
  apiUrl?: string;
  /** Deadline for each control-plane request. Default: 90 seconds. */
  requestTimeoutMs?: number;
}
export interface BoatNative {
  readonly sandbox: BoatSandbox;
  readonly client: BoatApi;
}
const prefix = "sandbox-sdk:1:";
const own = { "sandbox-sdk": "1" };
const presets = { small: "small", medium: "default", large: "large" } satisfies Record<
  string,
  "small" | "default" | "large"
>;

// Boat has no labels. Keep metadata in its display name so stopped VMs remain
// discoverable. Never allow the API's silent 120-character truncation.
function metadataName(input: CreateInput) {
  const labels = { ...input.labels };
  delete labels["sandbox-sdk"];
  const json = JSON.stringify([input.key ?? null, labels]);
  if (Buffer.byteLength(json) > 65_536)
    throw failure("Key and labels exceed the metadata size limit", "unsupported");
  const name = prefix + deflateRawSync(json).toString("base64url");
  if (name.length > 120)
    throw failure("Key and labels exceed Boat's encoded name budget; shorten them", "unsupported");
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
function info(raw: BoatSandbox): SandboxInfo {
  const data = metadata(raw.name);
  if (!data)
    throw failure(
      "Sandbox has no valid SDK metadata; connect an SDK-created sandbox",
      "not_found",
      raw.id,
    );
  const createdAt = raw.createdAt?.getTime();
  if (createdAt === undefined || !Number.isFinite(createdAt))
    throw failure("Boat returned no valid creation timestamp", "provider", raw.id);
  return {
    id: raw.id,
    ...data,
    createdAt,
    state: ["ready", "idle", "running"].includes(raw.state) ? "running" : "stopped",
  };
}
function fileInfo(value: unknown): FileInfo {
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
    throw failure("Invalid file metadata from Boat");
  const type = value.type;
  if (type !== "file" && type !== "directory" && type !== "symlink")
    throw failure("Invalid file type from Boat");
  return { path: value.path, type, size: value.size, modifiedAt: value.modifiedAt };
}
const statScript = `const fs=require('fs'),p=require('path');const stat=x=>{const s=fs.lstatSync(x);return {path:x,type:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':'file',size:s.size,modifiedAt:s.mtimeMs}};`;

/** Direct optional SDK with no installed remote agent or local daemon. */
export function boat(options: BoatOptions = {}): Provider<BoatNative, "size"> {
  let client: Promise<BoatApi> | undefined;
  let nativeClient: BoatApi | undefined;
  const environmentFiles = new Map<string, Map<string, Promise<string>>>();
  const environments = new Map<string, Record<string, string>>();
  const boxes = new Map<string, BoatSandbox>();
  async function api() {
    return (client ??= (async () => {
      const key = options.apiKey ?? process.env.BOAT_API_KEY;
      if (!key) throw failure("Boat API key is missing; set BOAT_API_KEY or apiKey", "auth");
      const timeoutMs = options.requestTimeoutMs ?? 90_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
        throw failure("requestTimeoutMs must be a positive integer", "invalid_argument");
      const { BoatApi, Configuration } = await import("@boatdev/sdk");
      nativeClient = new BoatApi(
        new Configuration({
          basePath: options.apiUrl ?? process.env.BOAT_API_BASE ?? "https://boat.dev/api/v1",
          accessToken: key,
          fetchApi: (url, init) =>
            fetch(url, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
                : AbortSignal.timeout(timeoutMs),
            }),
        }),
      );
      return nativeClient;
    })());
  }
  async function safe<T>(action: () => Promise<T>, id?: string): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw boatError(error, id);
    }
  }
  async function raw(id: string, command: string, file = false) {
    const result = await (
      await api()
    ).command({ sandboxId: id, commandRequest: { command, timeoutSeconds: 60 } });
    if (!("stdout" in result))
      throw failure("Boat returned an unexpected detached result", "outcome_unknown", id);
    if (result.stdoutTruncated || result.stderrTruncated)
      throw failure(
        "Boat truncated operation output; no partial file data was returned",
        "provider",
        id,
      );
    if (result.exitCode !== 0)
      throw failure(
        file && result.exitCode === 44
          ? "File does not exist"
          : "Boat file or setup operation failed",
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
  const provider: Provider<BoatNative, "size"> = {
    name: "boat",
    keyMode: "best-effort",
    capabilities: new Set(["size"]),
    create: (input) =>
      safe(async () => {
        if (input.network !== undefined && input.network !== "all")
          throw failure("Boat network policy is unsupported by this adapter", "unsupported");
        if (input.size !== undefined && typeof input.size !== "string")
          throw failure(
            "Boat supports small, medium and large presets; custom sizes are unavailable",
            "unsupported",
          );
        if (input.idleTimeoutMs !== undefined || input.timeoutMs !== undefined)
          throw failure(
            "Boat auto-stop is resettable and is not an idle timer or hard lifetime; timeoutMs and idleTimeoutMs are unsupported",
            "unsupported",
          );
        if (input.from !== undefined)
          throw failure("Boat snapshots are not supported by this adapter", "unsupported");
        const name = metadataName(input);
        if (input.signal?.aborted) throw failure("Creation was aborted", "aborted");
        const sdk = await api();
        const request = {
          idempotencyKey: crypto.randomUUID(),
          createSandboxRequest: {
            noEnv: true,
            env: input.env,
            type: input.size === undefined ? undefined : presets[input.size],
          },
        };
        // A response may be lost after Boat accepts the VM. Retry only with the
        // same documented idempotency key and identical body, including on abort,
        // so a late VM can be recovered and destroyed below.
        let sandbox: BoatSandbox | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            sandbox = (await sdk.create(request)).sandbox;
            break;
          } catch (error) {
            const code = boatError(error).code;
            if (["auth", "invalid_argument", "quota", "not_found"].includes(code)) throw error;
            if (attempt === 2)
              throw failure(
                `Boat create outcome remains unknown; recover with idempotency key ${request.idempotencyKey} and the same request body within 24 hours`,
                "outcome_unknown",
              );
            await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
        if (!sandbox) throw failure("Boat returned no sandbox after create", "outcome_unknown");
        environments.set(sandbox.id, { ...input.env });
        try {
          if (input.signal?.aborted) throw failure("Creation was aborted", "aborted");
          await sdk.update({ sandboxId: sandbox.id, updateSandboxRequest: { name } });
          // Commands wait for provisioning. /workspace is writable by Boat's user.
          await raw(
            sandbox.id,
            'sudo mkdir -p /workspace && sudo chown "$(id -u):$(id -g)" /workspace && command -v node git tar setsid nohup mkfifo sed base64 >/dev/null',
          );
          if (input.signal?.aborted) throw failure("Creation was aborted", "aborted");
          return await provider.connect(sandbox.id);
        } catch (error) {
          await provider.destroy(sandbox.id);
          throw error;
        }
      }),
    connect: (id) =>
      safe(async () => {
        const { sandbox } = await (await api()).get({ sandboxId: id });
        const result = info(sandbox);
        boxes.set(id, sandbox);
        return result;
      }, id),
    list: (labels) =>
      safe(async () => {
        const values: SandboxInfo[] = [];
        let cursor: string | undefined;
        const visited = new Set<string>();
        do {
          const page = await (await api()).sandboxes({ limit: 200, cursor });
          for (const sandbox of page.sandboxes) {
            if (!metadata(sandbox.name)) continue;
            const value = info(sandbox);
            if (Object.entries(labels).every(([key, expected]) => value.labels[key] === expected)) {
              values.push(value);
              boxes.set(value.id, sandbox);
            }
          }
          if (!page.pageInfo?.hasMore) break;
          const next = page.pageInfo.nextCursor;
          if (!next || visited.has(next))
            throw failure("Boat returned an invalid pagination cursor");
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
          await (await api()).deleteSandbox({ sandboxId: id, xAsciiConfirmDelete: id });
        } catch (error) {
          if (boatError(error).code !== "not_found") throw error;
        }
        boxes.delete(id);
        environments.delete(id);
        environmentFiles.delete(id);
      }, id),
    exec: (id, input) => safe(async () => {
      let files = environmentFiles.get(id);
      if (!files) { files = new Map(); environmentFiles.set(id, files); }
      return execute(await api(), id, input, environments.get(id), files);
    }, id),
    files: {
      readRange: (id, path, range) => readRange(id, path, range.offset, range.length),
      read: async (id, path) => {
        // Read follows symlinks, so measure the target rather than lstat metadata.
        const size = Number(
          await node(
            id,
            "process.stdout.write(String(require('fs').statSync(process.argv[1]).size))",
            [path],
          ),
        );
        if (!Number.isSafeInteger(size) || size < 0) throw failure("Invalid Boat file size");
        if (size <= 1024 * 1024) return readRange(id, path, 0, size);
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
            const link = await (await api()).createDownloadUrl({ sandboxId: id, fileUrlRequest: { path: staged, ttlSeconds: 300 } });
            const response = await fetch(link.url, { signal: AbortSignal.timeout(options.requestTimeoutMs ?? 90_000) });
            if (!response.ok) {
              await response.body?.cancel();
              throw failure("Signed file download failed", "unavailable", id);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length !== copiedSize) throw failure("Incomplete signed file download", "provider", id);
            return bytes;
          } finally {
            await node(id, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [dir]).catch(() => {});
          }
        }, id);
      },
      write: (id, path, data) =>
        safe(async () => {
          // Boat's files API only accepts /home/user and /tmp. Stage bytes there,
          // then copy inside the VM so /workspace and large writes still work.
          // File contents (including core's redaction rules) never enter argv.
          const dir = `/tmp/.sandbox-sdk/write-${crypto.randomUUID()}`;
          const chunkPath = `${dir}/chunk`;
          try {
            await node(
              id,
              "const f=require('fs');f.mkdirSync('/tmp/.sandbox-sdk',{recursive:true});f.mkdirSync(process.argv[1],{mode:0o700});f.writeFileSync(process.argv[1]+'/chunk','',{flag:'wx',mode:0o600})",
              [dir],
            );
            const chunkSize = 4 * 1024 * 1024;
            for (let offset = 0; offset < Math.max(data.length, 1); offset += chunkSize) {
              await (
                await api()
              ).writeFile({
                sandboxId: id,
                fileWriteRequest: {
                  path: chunkPath,
                  content: Buffer.from(data.subarray(offset, offset + chunkSize)).toString(
                    "base64",
                  ),
                  encoding: "base64",
                },
              });
              await node(
                id,
                "const f=require('fs');f.mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});f.writeFileSync(process.argv[1],f.readFileSync(process.argv[2]),{flag:process.argv[3]})",
                [path, chunkPath, offset ? "a" : "w"],
              );
            }
          } finally {
            await node(id, "require('fs').rmSync(process.argv[1],{recursive:true,force:true})", [
              dir,
            ]).catch(() => {});
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
        return fileInfo(value);
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
        if (!Array.isArray(value)) throw failure("Invalid Boat directory listing");
        return value.map(fileInfo);
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
        const result = await (await api()).hostPort({ sandboxId: id, hostPortRequest: { port } });
        if (!result.url) throw failure("Boat returned no preview URL", "provider", id);
        const url = new URL(result.url);
        const token = url.searchParams.get("_token");
        // Boat exchanges this token for an identically valued _port_auth cookie
        // through a redirect. Server fetch has no browser cookie jar.
        if (token) {
          if (!/^[A-Za-z0-9._~-]+$/.test(token)) throw failure("Invalid preview token", "provider", id);
          url.searchParams.delete("_token");
          return { url: url.toString(), headers: { Cookie: `_port_auth=${token}` } };
        }
        if (result.isProtected || result.access === "private")
          throw failure("Protected preview returned no token", "provider", id);
        return { url: url.toString() };
      }, id),
    native(id) {
      const sandbox = boxes.get(id);
      if (!sandbox || !nativeClient)
        throw failure("Sandbox is not connected; connect it first", "not_found", id);
      return { sandbox, client: nativeClient };
    },
  };
  return provider;
}

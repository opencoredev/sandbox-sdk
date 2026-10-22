import type { Session } from "@tenkicloud/sandbox";
import type { FileInfo, ProviderFiles } from "../../provider.js";
import { raw } from "./exec.js";
import { failure, tenkiError } from "./errors.js";
import { deadline } from "./deadline.js";
const script = `import os,sys,json,stat,shutil,base64
op,p=sys.argv[1:3]
def info(p):
 s=os.lstat(p)
 return dict(path=p,type='symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file',size=s.st_size,modifiedAt=s.st_mtime*1000)
try:
 if op=='read':
  with open(p,'rb') as f: print(base64.b64encode(f.read()).decode())
 elif op=='write':
  os.makedirs(os.path.dirname(p),exist_ok=True)
  with open(p,'wb') as f: f.write(sys.stdin.buffer.read())
 elif op=='mkdir': os.makedirs(p,exist_ok=True)
 elif op=='stat': print(json.dumps(info(p)))
 elif op=='list': print(json.dumps([info(os.path.join(p,n)) for n in os.listdir(p)]))
 elif op=='remove':
  if os.path.isdir(p) and not os.path.islink(p):
   if sys.argv[3]=='true': shutil.rmtree(p)
   else: os.rmdir(p)
  else: os.unlink(p)
except FileNotFoundError: print('SDK_FILE_NOT_FOUND')
except OSError: print('SDK_FILE_ERROR')
`;
function file(value: unknown): FileInfo {
  if (
    !value ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("type" in value) ||
    !["file", "directory", "symlink"].includes(String(value.type)) ||
    !("size" in value) ||
    typeof value.size !== "number" ||
    !("modifiedAt" in value) ||
    typeof value.modifiedAt !== "number"
  )
    throw failure("Invalid file metadata");
  const type = value.type;
  if (type !== "file" && type !== "directory" && type !== "symlink")
    throw failure("Invalid file type");
  return { path: value.path, type, size: value.size, modifiedAt: value.modifiedAt };
}
export function files(
  get: (id: string) => Promise<Session>,
  safe: <T>(id: string, action: () => Promise<T>) => Promise<T>,
): ProviderFiles {
  const call = (id: string, op: string, path: string, data?: Uint8Array, recursive?: boolean) =>
    safe(id, async () => {
      const result = await raw(
        await get(id),
        ["python3", "-c", script, op, path, String(recursive)],
        data,
      );
      if (result.trim() === "SDK_FILE_NOT_FOUND")
        throw failure("File does not exist", "file_not_found");
      if (result.trim() === "SDK_FILE_ERROR")
        throw failure(
          "File operation failed; check permissions and recursive removal",
          "invalid_argument",
        );
      return result;
    });
  async function nativePath(id: string, path: string) {
    if (path === "/workspace" || path.startsWith("/workspace/")) {
      // Tenki uses RESOLVE_BENEATH: even a link leaving and re-entering
      // /home/tenki is rejected. Resolve the caller's current root in the guest.
      const root = (await raw(await get(id), ["readlink", "-f", "/workspace"])).replace(/\n$/, "");
      return root === "/home/tenki" || root.startsWith("/home/tenki/")
        ? `${root}${path.slice(10)}`
        : undefined;
    }
    return path.startsWith("/home/tenki/") ? path : undefined;
  }
  async function transfer<T>(action: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try {
      return await deadline(action, 30_000);
    } catch (error) {
      // Native APIs reject symlinks escaping /home/tenki. Preserve arbitrary
      // guest paths with the privileged transport in that case.
      const code = tenkiError(error).code;
      if (code === "auth" || code === "invalid_argument" || code === "unsupported")
        return fallback();
      throw error;
    }
  }
  return {
    writeCreatesParents: true,
    read: (id, path) =>
      safe(id, async () => {
        const resolved = await nativePath(id, path);
        const fallback = async () =>
          new Uint8Array(Buffer.from(await call(id, "read", path), "base64"));
        return resolved
          ? transfer(async () => (await get(id)).readFile(resolved), fallback)
          : fallback();
      }),
    write: (id, path, data) =>
      safe(id, async () => {
        const resolved = await nativePath(id, path);
        const fallback = async () => {
          await call(id, "write", path, data);
        };
        if (resolved)
          await transfer(async () => (await get(id)).writeFile(resolved, data), fallback);
        else await fallback();
      }),
    mkdir: async (id, path) => {
      await call(id, "mkdir", path);
    },
    remove: async (id, path, options) => {
      await call(id, "remove", path, undefined, options.recursive);
    },
    stat: async (id, path) => file(JSON.parse(await call(id, "stat", path))),
    list: async (id, path) => {
      const value: unknown = JSON.parse(await call(id, "list", path));
      if (!Array.isArray(value)) throw failure("Invalid file listing");
      return value.map(file);
    },
  };
}

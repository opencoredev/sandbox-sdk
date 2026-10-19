import type { FileInfo, ProviderFiles } from "../../provider.js";
import { SandboxError, type ErrorCode } from "../../errors.js";
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export const python = (code: string, ...args: string[]) =>
  `python3 -c ${quote(code)} ${args.map(quote).join(" ")}`;
export interface Guest {
  name: string;
  raw(command: string): Promise<string>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string, range?: { offset: number; length: number }): Promise<Uint8Array>;
}
const fail = (g: Guest, text: string, code: ErrorCode = "provider") =>
  new SandboxError(`${text}. Check the ${g.name} sandbox before retrying.`, {
    code,
    provider: g.name,
  });
const metadata = `import os,sys,json,stat
p=sys.argv[1]
def info(p):
 s=os.lstat(p)
 return dict(path=p,type='symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file',size=s.st_size,modifiedAt=s.st_mtime*1000)
try: print(json.dumps([info(os.path.join(p,n)) for n in os.listdir(p)] if sys.argv[2]=='list' else info(p)))
except FileNotFoundError: print('SDK_FILE_NOT_FOUND')`;
function file(g: Guest, v: unknown): FileInfo {
  if (
    !v ||
    typeof v !== "object" ||
    !("path" in v) ||
    typeof v.path !== "string" ||
    !("type" in v) ||
    (v.type !== "file" && v.type !== "directory" && v.type !== "symlink") ||
    !("size" in v) ||
    typeof v.size !== "number" ||
    !("modifiedAt" in v) ||
    typeof v.modifiedAt !== "number"
  )
    throw fail(g, "Invalid file metadata");
  return { path: v.path, type: v.type, size: v.size, modifiedAt: v.modifiedAt };
}
export function files(
  get: (id: string) => Promise<Guest>,
  safe: <T>(id: string, action: () => Promise<T>) => Promise<T>,
): ProviderFiles {
  const info = async (id: string, path: string, op: string) => {
    const g = await get(id);
    const text = await g.raw(python(metadata, path, op));
    if (text.trim() === "SDK_FILE_NOT_FOUND")
      throw fail(g, "File does not exist", "file_not_found");
    const value: unknown = JSON.parse(text);
    return { g, value };
  };
  return {
    writeCreatesParents: true,
    readRange: (id, path, range) => safe(id, async () => (await get(id)).read(path, range)),
    read: (id, path) => safe(id, async () => (await get(id)).read(path)),
    write: (id, path, data) =>
      safe(id, async () => {
        const g = await get(id);
        try {
          await safe(id, () => g.upload(path, data));
        } catch (error) {
          if (
            !(error instanceof SandboxError) ||
            !["not_found", "file_not_found"].includes(error.code)
          )
            throw error;
          await g.raw(
            python("import os,sys; os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True)", path),
          );
          await g.upload(path, data);
        }
      }),
    stat: (id, path) =>
      safe(id, async () => {
        const { g, value } = await info(id, path, "stat");
        return file(g, value);
      }),
    list: (id, path) =>
      safe(id, async () => {
        const { g, value } = await info(id, path, "list");
        if (!Array.isArray(value)) throw fail(g, "Invalid directory listing");
        return value.map((v) => file(g, v));
      }),
    mkdir: (id, path) =>
      safe(id, async () => {
        await (
          await get(id)
        ).raw(python("import os,sys; os.makedirs(sys.argv[1],exist_ok=True)", path));
      }),
    remove: (id, path, options) =>
      safe(id, async () => {
        await (
          await get(id)
        ).raw(
          python(
            `import os,sys,shutil
p=sys.argv[1]
if os.path.isdir(p) and not os.path.islink(p):
 if sys.argv[2]=='true': shutil.rmtree(p)
 else: os.rmdir(p)
else: os.unlink(p)`,
            path,
            String(options.recursive),
          ),
        );
      }),
  };
}

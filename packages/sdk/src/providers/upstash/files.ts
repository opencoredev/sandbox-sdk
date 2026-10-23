import { posix } from "node:path";
import type { Box } from "@upstash/box";
import { SandboxError } from "../../errors.js";
import { upstashError } from "./errors.js";

// Base64 plus JSON must fit the native request body; read ranges cap at 8 MiB.
const chunkSize = 4 * 1024 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
export async function readFile(box: Box, path: string, range?: { offset: number; length: number }) {
  if (!range) {
    // An unbounded read is one request and about 30 ms faster than a bounded
    // one. Fall back to chunked ranges only if the provider refuses its size.
    try { return new Uint8Array(Buffer.from(await box.files.read(path, { encoding: "base64" }), "base64")); }
    catch (error) {
      if (["auth", "file_not_found", "not_found", "quota"].includes(upstashError(error, box.id, true).code)) throw error;
    }
  }
  const parts: Buffer[] = [];
  let offset = range?.offset ?? 0;
  let remaining = range?.length ?? Infinity;
  while (remaining > 0) {
    const length = Math.min(chunkSize, remaining);
    const bytes = Buffer.from(await box.files.read(path, { offset, length, encoding: "base64" }), "base64");
    parts.push(bytes);
    offset += bytes.length;
    remaining -= bytes.length;
    if (bytes.length < length) break;
  }
  return new Uint8Array(Buffer.concat(parts));
}
export async function writeFile(box: Box, path: string, data: Uint8Array, prepare?: string) {
  if (prepare) {
    const script = "import os,sys; p=sys.argv[1]; os.makedirs(os.path.dirname(p),exist_ok=True); f=open(p,'wb'); f.write(sys.stdin.buffer.read()); f.close()";
    const session = await box.exec.session({ argv: ["sh", "-c", `${prepare} && exec python3 -c "$1" "$2"`, "sh", script, path], cwd: "/" });
    try {
      session.write(data); session.endStdin();
      if (await session.wait() !== 0) throw new SandboxError("File write failed. Check workspace permissions and Python availability.", { code: "provider", provider: "upstash", sandboxId: box.id });
      return;
    } finally { session.close(); }
  }
  const write = async (path: string, bytes: Uint8Array) => {
    const params = { path, content: Buffer.from(bytes).toString("base64"), encoding: "base64" } satisfies Parameters<Box["files"]["write"]>[0];
    try { await box.files.write(params); }
    catch (error) {
      if (upstashError(error, box.id, true).code !== "file_not_found") throw error;
      await box.files.mkdir(posix.dirname(path), { parents: true });
      await box.files.write(params);
    }
  };
  if (data.length <= chunkSize) return write(path, data);
  const dir = `/tmp/.sandbox-sdk/upload-${crypto.randomUUID()}`;
  const prepared = await box.exec.command(`umask 077; mkdir -p /tmp/.sandbox-sdk && mkdir ${quote(dir)}`);
  if (prepared.exitCode !== 0) throw new SandboxError("Private upload staging could not be created. Check guest permissions.", { code: "provider", provider: "upstash", sandboxId: box.id });
  let submitted = false;
  try {
    let count = 0;
    for (let offset = 0; offset < data.length; offset += chunkSize)
      await write(`${dir}/${count++}`, data.subarray(offset, offset + chunkSize));
    // No append RPC exists. Assemble only after every binary chunk has arrived.
    const script = `import os,sys,shutil,tempfile,stat
p,d,n=sys.argv[1:]; p=os.path.realpath(p); tmp=None
try:
 os.makedirs(os.path.dirname(p),exist_ok=True)
 mode=stat.S_IMODE(os.stat(p).st_mode) if os.path.exists(p) else 0o644
 with tempfile.NamedTemporaryFile(dir=os.path.dirname(p),prefix='.sandbox-upload-',delete=False) as out:
  tmp=out.name; os.fchmod(out.fileno(),mode)
  for i in range(int(n)):
   with open(d+'/'+str(i),'rb') as part: shutil.copyfileobj(part,out)
  out.flush(); os.fsync(out.fileno())
 os.replace(tmp,p); tmp=None
finally:
 if tmp is not None: os.unlink(tmp)
 shutil.rmtree(d,ignore_errors=True)`;
    submitted = true;
    let result: Awaited<ReturnType<Box["exec"]["command"]>>;
    try { result = await box.exec.command(`python3 -c ${quote(script)} ${quote(path)} ${quote(dir)} ${count}`); }
    catch {
      // The HTTP deadline does not stop guest execution. Only the guest may
      // remove its inputs once submission has an unknown outcome.
      throw new SandboxError(`Large upload outcome is unknown. Inspect ${dir} and the destination before retrying; destroy the sandbox to remove any retained staging.`, { code: "outcome_unknown", provider: "upstash", sandboxId: box.id });
    }
    if (result.exitCode !== 0) {
      await box.files.remove(dir, { recursive: true }).catch(() => {});
      throw new SandboxError("Large file assembly failed. Check guest Python and destination permissions.", { code: "provider", provider: "upstash", sandboxId: box.id });
    }
  } finally {
    if (!submitted) await box.files.remove(dir, { recursive: true });
  }
}
// Native list lacks symlink and special-file types, so each entry needed its own
// stat call. One guest lstat pass returns the same metadata in a single request.
// Like the native list, a missing path or a non-directory lists as empty.
const listScript = `import os,sys,json,stat
p=sys.argv[1]
try: names=os.listdir(p)
except (FileNotFoundError,NotADirectoryError): names=[]
out=[]
for n in names:
 try: s=os.lstat(os.path.join(p,n))
 except FileNotFoundError: print('SDK_FILE_NOT_FOUND'); sys.exit(0)
 m=s.st_mode
 out.append([n.encode('utf-8','surrogateescape').decode('utf-8','replace'),'symlink' if stat.S_ISLNK(m) else 'directory' if stat.S_ISDIR(m) else 'file' if stat.S_ISREG(m) else 'other',s.st_size,s.st_mtime_ns//1000000])
print(json.dumps(out))`;
export type ListedEntry = { name: string; type: "file" | "directory" | "symlink" | "other"; size: number; modifiedAt: number };
function listed(value: unknown): ListedEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: ListedEntry[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 4) return undefined;
    const [name, type, size, modifiedAt]: unknown[] = item;
    if (
      typeof name !== "string" ||
      (type !== "file" && type !== "directory" && type !== "symlink" && type !== "other") ||
      typeof size !== "number" ||
      typeof modifiedAt !== "number"
    )
      return undefined;
    entries.push({ name, type, size, modifiedAt });
  }
  return entries;
}
/** Returns undefined when the guest cannot answer (no python3, truncated output),
 * so the caller can use the native list-then-stat path instead. */
export async function listDirectory(box: Box, path: string, prepare?: string): Promise<ListedEntry[] | undefined> {
  if (!path.startsWith("/")) return undefined;
  const result = await box.exec.command(`${prepare ? `${prepare} && ` : ""}python3 -c ${quote(listScript)} ${quote(path)}`);
  if (result.exitCode !== 0) return undefined;
  const text = result.stdout.trim();
  if (text === "SDK_FILE_NOT_FOUND")
    throw Object.assign(new Error("Directory entry vanished during listing"), { statusCode: 404 });
  try { return listed(JSON.parse(text)); }
  catch { return undefined; }
}

import type { FileInfo, ProviderFiles } from "../../provider.js";
import { SandboxError, type ErrorCode } from "../../errors.js";
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export const python = (code: string, ...args: string[]) =>
  `python3 -c ${quote(code)} ${args.map(quote).join(" ")}`;
// Linux guests can launch without importing subprocess/tempfile on every run.
// posix_spawn establishes the session before returning its PID to cancellation.
export const guestProcess = `def stdin_file():
 try: return os.fdopen(os.memfd_create('sandbox-sdk-stdin'),'w+b')
 except (AttributeError,OSError):
  import tempfile
  return tempfile.TemporaryFile()
class Process:
 def __init__(self,v,env,stdin,session=False):
  if not all(hasattr(os,name) for name in ['posix_spawn','waitstatus_to_exitcode']):
   self.legacy(v,env,stdin,session); return
  directory=os.open('.',os.O_RDONLY)
  r,w=os.pipe(); e,x=os.pipe()
  try:
   os.chdir(v['cwd'])
   error=FileNotFoundError(2,os.strerror(2),'sh')
   signals=[getattr(signal,s) for s in ['SIGPIPE','SIGXFZ','SIGXFSZ'] if hasattr(signal,s)]
   for path in os.get_exec_path(env):
    try:
     self.pid=os.posix_spawn(os.path.join(path,'sh'),['sh','-c',v['command']],env,file_actions=[(os.POSIX_SPAWN_DUP2,stdin.fileno(),0),(os.POSIX_SPAWN_DUP2,w,1),(os.POSIX_SPAWN_DUP2,x,2)],setsid=session,setsigdef=signals)
     break
    except (FileNotFoundError,NotADirectoryError): pass
    except OSError as failure:
     if failure.errno==38: raise NotImplementedError()
     error=failure
   else: raise error
  except NotImplementedError:
   os.close(r); os.close(e)
   self.legacy(v,env,stdin,session); return
  except BaseException:
   os.close(r); os.close(e); raise
  finally:
   os.fchdir(directory); os.close(directory); os.close(w); os.close(x)
  self.stdout=os.fdopen(r,'rb',buffering=0); self.stderr=os.fdopen(e,'rb',buffering=0)
  self.code=None
 def legacy(self,v,env,stdin,session):
  import subprocess
  self.child=subprocess.Popen(['sh','-c',v['command']],cwd=v['cwd'],env=env,stdin=stdin,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=session)
  self.pid=self.child.pid; self.stdout=self.child.stdout; self.stderr=self.child.stderr
 def poll(self):
  if hasattr(self,'child'): return self.child.poll()
  if self.code is None:
   pid,status=os.waitpid(self.pid,os.WNOHANG)
   if pid: self.code=os.waitstatus_to_exitcode(status)
  return self.code
 def wait(self):
  if hasattr(self,'child'): return self.child.wait()
  if self.code is None: self.code=os.waitstatus_to_exitcode(os.waitpid(self.pid,0)[1])
  return self.code
`;
export interface Guest {
  name: string;
  raw(command: string): Promise<string>;
  /** Guests that apply `mode` themselves must also set `writeSupportsMode` on their files. */
  upload(path: string, bytes: Uint8Array, mode?: number): Promise<void>;
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
    write: (id, path, data, options) =>
      safe(id, async () => {
        const g = await get(id);
        try {
          await safe(id, () => g.upload(path, data, options?.mode));
        } catch (error) {
          if (
            !(error instanceof SandboxError) ||
            !["not_found", "file_not_found"].includes(error.code)
          )
            throw error;
          await g.raw(
            python("import os,sys; os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True)", path),
          );
          await g.upload(path, data, options?.mode);
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
        const g = await get(id);
        const text = await g.raw(
          python(
            `import os,sys,shutil
p=sys.argv[1]
try:
 if os.path.isdir(p) and not os.path.islink(p):
  if sys.argv[2]=='true': shutil.rmtree(p)
  else: os.rmdir(p)
 else: os.unlink(p)
except FileNotFoundError: print('SDK_FILE_NOT_FOUND')`,
            path,
            String(options.recursive),
          ),
        );
        // Like the other providers, removing a missing path is file_not_found.
        if (text.trim() === "SDK_FILE_NOT_FOUND") throw fail(g, "File does not exist", "file_not_found");
      }),
  };
}

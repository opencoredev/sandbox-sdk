import { createHash } from "node:crypto";
import type { FileInfo, ProviderFiles } from "../provider.js";
import { SandboxError, type ErrorCode } from "../errors.js";
import { isNumber, isObject, isString } from "./narrow.js";
import { quote } from "./shell.js";

// Guest helpers use only the standard library, so skip site-packages discovery:
// it is a third of interpreter startup on a small VM.
export const python = (code: string, ...args: string[]) =>
  `python3 -S -c ${quote(code)} ${args.map(quote).join(" ")}`;

/**
 * Wraps a per-command supervisor so the guest compiles it once, not on every
 * command: compiling ~5 KB of source costs 2-5 ms on a small VM. The source still
 * travels with each command, so a missing, foreign or stale cache only means a
 * compile. A cache entry is used only when this user owns it, nobody else can
 * write it, and it was compiled from this exact source by this interpreter.
 * `store` is the Python condition under which a compile writes the cache.
 */
export function cachedPython(
  source: string,
  run = "exec(c,{'__name__':'__main__','__builtins__':__builtins__})",
  store = "True",
): string {
  // The source travels as a raw triple-quoted literal.
  if (source.includes("'''") || source.endsWith("\\"))
    throw new Error("Supervisor source cannot be embedded");
  const name = createHash("sha256").update(source).digest("hex").slice(0, 16);

  return `import os,sys,marshal
s=r'''${source}'''
p='/tmp/.sandbox-sdk/py-${name}.'+sys.implementation.cache_tag
c=None
try:
 with open(p,'rb') as f:
  t=os.fstat(f.fileno())
  if t.st_uid==os.geteuid() and not t.st_mode&0o022:
   k,c=marshal.load(f)
   if k!=(sys.version,s): c=None
except Exception: c=None
w=c is None
if w: c=compile(s,'<sandbox-sdk>','exec')
if w and ${store}:
 t=p+'.'+str(os.getpid())
 try:
  with open(os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f: marshal.dump(((sys.version,s),c),f)
  os.replace(t,p)
 except OSError:
  try: os.unlink(t)
  except OSError: pass
${run}
`;
}

// The zygote: a warm interpreter per sandbox that forks one child per command.
// The child adopts the waiting client's stdin, stdout, stderr, cwd, umask and
// environment through /proc, then runs the same supervisor code as a one-shot
// launch would, so a command behaves the same whichever path runs it.
const zygoteServer = `def serve(code,z):
 import fcntl,_signal as signal
 base=os.path.dirname(z)
 try:
  os.makedirs(z,mode=0o700,exist_ok=True)
  lock=os.open(z+'/lock',os.O_WRONLY|os.O_CREAT,0o600)
 except OSError: return
 try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except OSError: return
 try:
  with open('/proc/sys/kernel/random/boot_id') as f: boot=f.read().strip()
  try: os.unlink(z+'/fifo')
  except FileNotFoundError: pass
  os.mkfifo(z+'/fifo',0o600)
  q=os.open(z+'/fifo',os.O_RDWR|os.O_NONBLOCK)
 except OSError:
  # A sandbox that cannot host a zygote must not relaunch one for every command.
  with open(z+'/off','w'): pass
  return
 me=('%d %s\\n'%(os.getpid(),boot)).encode()
 t=z+'/pid.%d'%os.getpid()
 with open(t,'wb') as f: f.write(me)
 os.replace(t,z+'/pid')
 signal.signal(signal.SIGCHLD,signal.SIG_IGN)
 def mine():
  try:
   with open(z+'/pid','rb') as f: return f.read()==me
  except OSError: return False
 try: loop(code,z,base,q,lock,mine)
 finally:
  # Any exit withdraws the record: new commands skip it, waiting ones take theirs back.
  if mine(): os.unlink(z+'/pid')
def loop(code,z,base,q,lock,mine):
 import select,time
 idle=time.monotonic()+30
 pending=b''
 while True:
  ready=select.select([q],[],[],5)[0]
  if not ready:
   # Stop when replaced, cleared by a client or removed with the sandbox's files.
   if not mine(): break
   # A claim matters only while its client waits; drop ones nobody removed.
   for entry in os.scandir(z):
    try:
     if entry.name.startswith('c-') and time.time()-entry.stat().st_mtime>600: os.unlink(entry.path)
    except FileNotFoundError: pass
   if time.monotonic()<idle: continue
   # Idle: stop advertising, then serve whatever was already queued.
   if mine(): os.unlink(z+'/pid')
  try: pending+=os.read(q,65536)
  except BlockingIOError: pass
  *lines,pending=pending.split(b'\\n')
  for line in lines:
   try:
    c,i=line.decode().split(' ')
    c=int(c)
   except ValueError: continue
   if len(i)!=36 or i.strip('0123456789abcdef-'): continue
   if os.fork()==0:
    try:
     # The lock and queue belong to this zygote, not to a long command.
     os.close(lock); os.close(q)
     handle(code,z,c,base+'/run-'+i,z+'/c-'+i)
    finally: os._exit(0)
  if not ready: break
  idle=time.monotonic()+30
def handle(code,z,c,root,claim):
 import _signal as signal
 signal.signal(signal.SIGCHLD,signal.SIG_DFL)
 # Whoever creates the claim owns the request: this child, or the client giving up.
 try: fd=os.open(claim,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 except OSError: return
 os.write(fd,b'%d\\n'%os.getpid())
 def started():
  try:
   with open('/proc/%d/stat'%c,'rb') as f: return f.read().rsplit(b')',1)[1].split()[19]
  except (OSError,IndexError): return None
 start=started()
 # A client that is gone has no one to run the command for.
 if start is None: return
 try:
  # The client keeps its own stdio on fds 7-9, which it never redirects.
  fds=[os.open('/proc/%d/fd/%d'%(c,7+n),os.O_RDONLY if n==0 else os.O_WRONLY) for n in range(3)]
  cwd=os.open('/proc/%d/cwd'%c,os.O_RDONLY)
  with open('/proc/%d/environ'%c,'rb') as f: env=f.read()
  with open('/proc/%d/status'%c) as f: mask=int(next(l for l in f if l.startswith('Umask:')).split()[1],8)
 except (OSError,StopIteration,ValueError):
  if started()!=start: return
  # Nothing has run: hand the request back. A live client whose stdio cannot be
  # adopted, such as sockets, means this sandbox should not route commands here.
  with open(z+'/off','w'): pass
  os.kill(c,signal.SIGUSR2)
  gone(c,start,claim)
  return
 if started()!=start: return
 for n,x in enumerate(fds): os.dup2(x,n); os.close(x)
 os.fchdir(cwd); os.close(cwd)
 os.umask(mask)
 os.environ.clear()
 for item in env.split(b'\\0'):
  k,s,v=item.partition(b'=')
  if s: os.environb[k]=v
 sys.argv=['-c',root]
 status=0
 try: exec(code,{'__name__':'__main__','__builtins__':__builtins__})
 except SystemExit as e:
  if isinstance(e.code,int): status=e.code
  elif e.code is not None: print(e.code,file=sys.stderr); status=1
 except BaseException:
  import traceback
  traceback.print_exc(); status=1
 for f in (sys.stdout,sys.stderr):
  try: f.flush()
  except Exception: pass
 os.write(fd,b'%d\\n'%(status&255)); os.close(fd)
 # Release the client's pipes before waking it, so its exit ends the native exec.
 null=os.open('/dev/null',os.O_RDWR)
 for n in range(3): os.dup2(null,n)
 if started()==start: os.kill(c,signal.SIGUSR1)
 gone(c,start,claim)
def gone(c,start,claim):
 import time
 # The claim is only needed while its client can still decide; drop it after.
 for _ in range(2000):
  try:
   with open('/proc/%d/stat'%c,'rb') as f: alive=f.read().rsplit(b')',1)[1].split()[19]==start
  except (OSError,IndexError): alive=False
  if not alive:
   os.unlink(claim); return
  time.sleep(.001)
`;

const zygoteDir = (program: string) =>
  `/tmp/.sandbox-sdk/z-${createHash("sha256").update(program).digest("hex").slice(0, 16)}`;

/**
 * A supervisor program that runs once (`python3 -S -c P root`) or as the
 * sandbox's zygote (`python3 -S -c P --serve dir`). See {@link zygoteCommand}.
 */
function zygotePython(source: string): string {
  if (zygoteServer.includes("'''")) throw new Error("Zygote source cannot be embedded");

  // One-shot runs skip compiling the server: it is a string until --serve. They
  // also leave writing the bytecode cache to the zygote they start next, which
  // takes that write off the command's critical path.
  return cachedPython(
    source,
    `if sys.argv[1:2]==['--serve']:
 exec(r'''${zygoteServer}''')
 serve(c,sys.argv[2])
else: exec(c,{'__name__':'__main__','__builtins__':__builtins__})`,
    "sys.argv[1:2]==['--serve']",
  );
}

/**
 * The shell command that runs `program` (from {@link zygotePython}) for one
 * request rooted at `root`, a `/tmp/.sandbox-sdk/run-<uuid>` directory path.
 *
 * With a live zygote for this exact program, the client copies its stdio to
 * fds 7-9, posts its PID and run ID to the zygote's FIFO and waits; the
 * zygote's child claims the request, adopts fds 7-9 and signals USR1 with the
 * exit status in the claim file. Fds 0-2 are not adopted: the client briefly
 * redirects them for its own commands.
 *
 * The client checks once a second. A request nobody claimed goes back to the
 * client when the zygote has died, or after 3 s from a zygote that is alive but
 * stalled; the client then clears the zygote record so later commands skip it.
 * A claimed request whose child died exits 70, like a supervisor that died. The
 * claim file is created exclusively, so exactly one side runs each request.
 * Without a usable zygote, the client runs the program itself. From the
 * sandbox's second such command on, it then starts a zygote for later ones: a
 * sandbox that runs one command never pays for a zygote, and on a one-CPU
 * sandbox the zygote's startup does not compete with its first commands.
 */
function zygoteCommand(program: string, root: string): string {
  const zygote = zygoteDir(program);

  return `{ P=${quote(program)}; r=${quote(root)}; z=${quote(zygote)}; f="$z/c-\${r##*/run-}"; n=1
if [ ! -e "$z/off" ] && read -r k b 2>/dev/null <"$z/pid" && read -r o </proc/sys/kernel/random/boot_id && [ "$b" = "$o" ] && kill -0 "$k" 2>/dev/null; then
trap 'kill "$w" 2>/dev/null; { read -r o; read -r c; } <"$f"; exit "\${c:-70}"' USR1
trap 'kill "$w" 2>/dev/null; n=1' USR2
n=0; t=0
exec 7<&0 8>&1 9>&2
sleep 1 </dev/null >/dev/null 2>&1 7<&- 8>&- 9>&- & w=$!
printf '%s %s\\n' "$$" "\${r##*/run-}" 1<>"$z/fifo"
while :; do
wait "$w"
[ "$n" = 0 ] || break
t=$((t+1))
if [ -s "$f" ]; then
{ read -r o <"$f" && kill -0 "$o"; } 2>/dev/null || exit 70
elif { ! kill -0 "$k" || [ "$t" -ge 3 ]; } 2>/dev/null && (set -C; : >"$f") 2>/dev/null; then
: >"$z/pid"; n=1; break
fi
sleep 1 </dev/null >/dev/null 2>&1 7<&- 8>&- 9>&- & w=$!
done
exec 7<&- 8>&- 9>&-
fi
python3 -S -c "$P" "$r"; c=$?
if [ -e "$z.seen" ]; then
{ [ -e "$z/off" ] || ! command -v setsid >/dev/null || exec setsid env -i PATH="$PATH" python3 -S -c "$P" --serve "$z"; } </dev/null >/dev/null 2>&1 &
else : >"$z.seen" 2>/dev/null; fi
exit "$c"; }`;
}

/**
 * Commands for a supervisor that can run from a zygote. A client's first
 * command in a sandbox runs the plain supervisor: a zygote only pays off from
 * later commands, and its client and server add ~10 KB to the command, which
 * Superserve charges for per request (~2 ms per KB on a fresh sandbox). That
 * command is the bare supervisor source, as before zygotes existed; it marks the
 * sandbox as reused, so the next command's one-shot starts the zygote.
 */
export function zygoteSupervisor(source: string) {
  const program = zygotePython(source);
  const seen = `${zygoteDir(program)}.seen`;
  // Sandboxes this client has sent a command; bounded, forgetting only costs a plain command.
  const used = new Set<string>();

  return {
    /**
     * Without `spec` the supervisor reads its hex spec from the command's stdin.
     * With it, the spec travels in the command: as an argument to the plain
     * supervisor, or as a heredoc that a zygote child can read as the client's stdin.
     */
    command(sandbox: string, root: string, spec?: string): string {
      if (spec !== undefined && !/^[0-9a-f]*$/.test(spec))
        throw new Error("Supervisor spec must be hex");

      if (used.has(sandbox))
        return spec === undefined
          ? zygoteCommand(program, root)
          : `${zygoteCommand(program, root)} <<'SDKSPEC'\n${spec}\nSDKSPEC`;

      if (used.size >= 10_000) used.clear();
      used.add(sandbox);

      return `{ python3 -S -c ${quote(source)} ${quote(root)}${spec === undefined ? "" : ` ${spec}`}; c=$?; : >${quote(seen)} 2>/dev/null; exit "$c"; }`;
    },
    zygote: (root: string) => zygoteCommand(program, root),
  };
}

// Linux guests can launch without importing subprocess/tempfile on every run.
// posix_spawn establishes the session before returning its PID to cancellation.
export const guestProcess = `def stdin_file():
 try: return os.fdopen(os.memfd_create('sandbox-sdk-stdin'),'w+b')
 except (AttributeError,OSError):
  import tempfile
  return tempfile.TemporaryFile()
class Process:
 # A missing cwd fails the command, not the supervisor: the shell reports it on stderr and exits 2.
 def argv(self,v):
  try: os.chdir(v['cwd']); return ['sh','-c',v['command']]
  except OSError: return ['sh','-c','cd "$1" || exit 2','sh',v['cwd']]
 def __init__(self,v,env,stdin,session=False):
  if not all(hasattr(os,name) for name in ['posix_spawn','waitstatus_to_exitcode']):
   self.legacy(v,env,stdin,session); return
  directory=os.open('.',os.O_RDONLY)
  r,w=os.pipe(); e,x=os.pipe()
  try:
   argv=self.argv(v)
   error=FileNotFoundError(2,os.strerror(2),'sh')
   signals=[getattr(signal,s) for s in ['SIGPIPE','SIGXFZ','SIGXFSZ'] if hasattr(signal,s)]
   for path in os.get_exec_path(env):
    # A missing candidate would cost a whole spawn and failed exec; skip it with one stat.
    if not os.path.exists(os.path.join(path,'sh')): continue
    try:
     self.pid=os.posix_spawn(os.path.join(path,'sh'),argv,env,file_actions=[(os.POSIX_SPAWN_DUP2,stdin.fileno(),0),(os.POSIX_SPAWN_DUP2,w,1),(os.POSIX_SPAWN_DUP2,x,2)],setsid=session,setsigdef=signals)
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
  directory=os.open('.',os.O_RDONLY)
  try: self.child=subprocess.Popen(self.argv(v),env=env,stdin=stdin,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=session)
  finally: os.fchdir(directory); os.close(directory)
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

// Relays both pipes in arrival order until they close and the shell exits, and
// kills the whole group at the deadline. The shell often exits just after its
// pipes close, so a SIGCHLD wakeup ends the wait at once instead of a poll tick.
// Needs os, select, time and _signal imported as signal.
export const guestPump = `def pump(p,emit,end):
 r,w=os.pipe(); os.set_blocking(w,False)
 signal.set_wakeup_fd(w,warn_on_full_buffer=False)
 signal.signal(signal.SIGCHLD,lambda *_:None)
 streams={p.stdout.fileno():('stdout',p.stdout),p.stderr.fileno():('stderr',p.stderr)}
 timed=False
 while streams or p.poll() is None:
  left=end-time.monotonic()
  if not timed and left<=0:
   timed=True
   try: os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError: pass
  for fd in select.select(list(streams)+[r],[],[],None if timed else max(left,0))[0]:
   if fd==r: os.read(r,512); continue
   data=os.read(fd,8192)
   if data: emit(streams[fd][0],data)
   else: streams.pop(fd)[1].close()
 return timed
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

// Prints argv[1] metadata as JSON, or its entries when argv[2] is "list".
const metadata = `import os,sys,json,stat
p=sys.argv[1]
def info(p):
 s=os.lstat(p)
 return dict(path=p,type='symlink' if stat.S_ISLNK(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'file',size=s.st_size,modifiedAt=s.st_mtime*1000)
try: print(json.dumps([info(os.path.join(p,n)) for n in os.listdir(p)] if sys.argv[2]=='list' else info(p)))
except FileNotFoundError: print('SDK_FILE_NOT_FOUND')`;

// Creates the parent directory of argv[1].
const makeParents = "import os,sys; os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True)";

// Creates directory argv[1] and its parents.
const makeDirectory = "import os,sys; os.makedirs(sys.argv[1],exist_ok=True)";

// Removes argv[1]; a directory only when empty unless argv[2] is "true".
const removePath = `import os,sys,shutil
p=sys.argv[1]
try:
 if os.path.isdir(p) and not os.path.islink(p):
  if sys.argv[2]=='true': shutil.rmtree(p)
  else: os.rmdir(p)
 else: os.unlink(p)
except FileNotFoundError: print('SDK_FILE_NOT_FOUND')`;

/** A guest metadata record, as the metadata programs print it. */
export function isFileInfo(value: unknown): value is FileInfo {
  return (
    isObject(value) &&
    "path" in value &&
    isString(value.path) &&
    "type" in value &&
    (value.type === "file" || value.type === "directory" || value.type === "symlink") &&
    "size" in value &&
    isNumber(value.size) &&
    "modifiedAt" in value &&
    isNumber(value.modifiedAt)
  );
}

/** Copies only the FileInfo fields, so extra JSON keys never reach callers. */
export function fileInfo(value: FileInfo): FileInfo {
  return { path: value.path, type: value.type, size: value.size, modifiedAt: value.modifiedAt };
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
          await g.raw(python(makeParents, path));
          await g.upload(path, data, options?.mode);
        }
      }),
    stat: (id, path) =>
      safe(id, async () => {
        const { g, value } = await info(id, path, "stat");

        if (!isFileInfo(value)) throw fail(g, "Invalid file metadata");

        return fileInfo(value);
      }),
    list: (id, path) =>
      safe(id, async () => {
        const { g, value } = await info(id, path, "list");

        if (!Array.isArray(value)) throw fail(g, "Invalid directory listing");

        return value.map((item) => {
          if (!isFileInfo(item)) throw fail(g, "Invalid file metadata");

          return fileInfo(item);
        });
      }),
    mkdir: (id, path) =>
      safe(id, async () => {
        await (await get(id)).raw(python(makeDirectory, path));
      }),
    remove: (id, path, options) =>
      safe(id, async () => {
        const g = await get(id);

        const text = await g.raw(python(removePath, path, String(options.recursive)));

        // Like the other providers, removing a missing path is file_not_found.
        if (text.trim() === "SDK_FILE_NOT_FOUND")
          throw fail(g, "File does not exist", "file_not_found");
      }),
  };
}

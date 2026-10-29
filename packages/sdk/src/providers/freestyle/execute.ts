import { guestSpec } from "../../shared/wire.js";
import type { ExecInput, ExecResult } from "../../provider.js";
import { guestProcess } from "../../shared/guest.js";
import { pagedExecute, type PagedGuest } from "../../shared/paged-exec.js";
import { quote } from "../../shared/shell.js";
import { failure } from "./errors.js";

export const supervisorPath = "/var/lib/sandbox-sdk-exec-v2.py";

// The one-shot launcher travels in the exec request; nothing is installed.
// Small results return inline; large output uses bounded native ranged reads.
export const supervisor = `import os,sys,marshal,_signal as signal,select,time,fcntl
${guestProcess}
root=sys.argv[1]
v=marshal.loads(bytes.fromhex(sys.stdin.read()))
if v.get('files') is not None:
 previous_umask=os.umask(0o077)
 os.makedirs('/workspace',exist_ok=True)
 os.makedirs('/tmp/.sandbox-sdk',exist_ok=True)
 for path,content in v['files']:
  os.makedirs(os.path.dirname(path),exist_ok=True)
  tmp=path+'.'+str(os.getpid())
  try:
   with open(tmp,'w') as f: f.write(content)
   os.replace(tmp,path)
  finally:
   if os.path.exists(tmp): os.unlink(tmp)
 os.umask(previous_umask)
os.makedirs(root,mode=0o700,exist_ok=True)
# Keep small completed responses until their request deadline has passed.
# Sweep expired responses inline, so no ack RPC or background daemon is needed.
with open(os.path.dirname(root)+'/.sweep','a') as sweep:
 try: fcntl.flock(sweep,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: pass
 else:
  if time.time()-os.fstat(sweep.fileno()).st_mtime>30:
   os.utime(sweep.fileno(),None)
   for entry in os.scandir(os.path.dirname(root)):
    if not entry.name.startswith('run-') or entry.path==root: continue
    try:
     with open(entry.path+'/expires') as f: expired=time.time()>float(f.read())
     if expired:
      import shutil
      shutil.rmtree(entry.path,ignore_errors=True)
    except (FileNotFoundError,NotADirectoryError): pass
a=v.get('activityPath')
timed=False
code=127
try:
 if a:
  os.makedirs(os.path.dirname(a),exist_ok=True)
  with open(a,'w') as f: f.write('1')
 try:
  with open('/var/lib/sandbox-sdk-env.json') as f:
   import json
   saved=json.load(f)
 except FileNotFoundError: saved={}
 env={**os.environ,**saved,**v['env']}
 with stdin_file() as f, open(root+'/out','wb',buffering=0) as out:
  f.write(v.get('stdin','').encode()); f.seek(0)
  with open(root+'/lock','w') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX)
   if os.path.exists(root+'/cancelled'): timed=True; p=None
   else:
    try: p=Process(v,env,f,True)
    except OSError as e:
     out.write(('["stderr","'+str(e).encode().hex()+'"]\\n').encode()); p=None
   if p:
    with open(root+'/pid','w') as m: m.write(str(p.pid))
  if p:
   stdout=p.stdout.fileno(); streams={stdout:'stdout',p.stderr.fileno():'stderr'}
   end=time.monotonic()+v['timeoutMs']/1000
   while streams or p.poll() is None:
    if not timed and time.monotonic()>=end:
     timed=True
     try: os.killpg(p.pid,signal.SIGKILL)
     except ProcessLookupError: pass
    for fd in select.select(list(streams),[],[],.01 if streams else .001)[0]:
     data=os.read(fd,8192)
     if data: out.write(('["'+streams[fd]+'","'+data.hex()+'"]\\n').encode())
     else: del streams[fd]; (p.stdout if fd==stdout else p.stderr).close()
   code=p.wait()
  timed=timed or os.path.exists(root+'/cancelled')
 result='{"exitCode":%s,"timedOut":%s}'%('null' if timed else str(code if code>=0 else 128-code),str(timed).lower())
 with open(root+'/exit','w') as f: f.write(result)
 size=os.path.getsize(root+'/out')
 with open(root+'/out','rb') as f:
  chunks=[line.decode().strip() for _,line in zip(range(3),f)]
  offset=f.tell()
 if offset==size and not timed:
  with open(root+'/expires','w') as f: f.write(str(time.time()+v['timeoutMs']/1000+5))
 if timed and not p:
  import shutil
  shutil.rmtree(root)
 print('{"result":%s,"chunks":[%s],"offset":%d,"size":%d}'%(result,','.join(chunks),offset,size))
finally:
 if a:
  try: os.unlink(a)
  except FileNotFoundError: pass
`;

export interface ExecutionGuest extends PagedGuest {
  exec(command: string, stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
}

export async function execute(
  g: ExecutionGuest,
  input: ExecInput,
  files?: [string, string][],
): Promise<ExecResult> {
  return pagedExecute({
    guest: g,
    input,
    fail: (message, code) => failure(message, code),
    launch: (root, signal) =>
      g.exec(
        `python3 -S -c ${quote(supervisor)} ${quote(root)}`,
        guestSpec({
          files,
          command: input.command,
          env: input.env,
          cwd: input.cwd,
          stdin: input.stdin ?? "",
          timeoutMs: input.timeoutMs,
          activityPath: input.activityPath,
        }).toString("hex"),
        input.timeoutMs + 5000,
        signal,
      ),
  });
}

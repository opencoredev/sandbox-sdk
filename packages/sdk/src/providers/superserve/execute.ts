import { guestSpec } from "../../shared/wire.js";
import type { ExecInput, ExecResult } from "../../provider.js";
import { guestProcess, guestPump, zygoteSupervisor } from "../../shared/guest.js";
import { pagedExecute, type PagedGuest } from "../../shared/paged-exec.js";
import { failure } from "./errors.js";

// The one-shot launcher travels in the native exec request. Small results
// return inline; large output uses bounded native ranged reads.
export const supervisor = `import os,sys,marshal,_signal as signal,select,time,fcntl
${guestProcess}
${guestPump}
root=sys.argv[1]
v=marshal.loads(bytes.fromhex(sys.argv[2])) if len(sys.argv)>2 else marshal.loads(bytes.fromhex(sys.stdin.read()))
if 'envKeys' in v: v['env']={k:os.environ[k] for k in v['envKeys']}
os.makedirs(root,mode=0o700,exist_ok=True)
# Keep small completed responses until their request deadline has passed.
# Sweep expired responses inline, at most every 30 seconds, so no ack RPC or
# background daemon is needed and a busy sandbox does not rescan every run.
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
 if os.environ.get('SANDBOX_SDK_BOOTSTRAP') not in (None,'{}'):
  bootstrap=os.environ.pop('SANDBOX_SDK_BOOTSTRAP')
  if bootstrap=='{"env":{}}': initial={}
  else:
   import json
   initial=json.loads(bootstrap).get('env')
  if initial is not None: saved=initial
  if initial is not None and (initial or os.path.exists('/var/lib/sandbox-sdk-env.json')):
   import json
   os.makedirs(os.path.dirname('/var/lib/sandbox-sdk-env.json'),exist_ok=True)
   tmp='/var/lib/sandbox-sdk-env.json.'+str(os.getpid())
   fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w') as f: json.dump(saved,f)
   os.replace(tmp,'/var/lib/sandbox-sdk-env.json')
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
   timed=pump(p,lambda name,data: out.write(('["'+name+'","'+data.hex()+'"]\\n').encode()),time.monotonic()+v['timeoutMs']/1000)
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

const launch = zygoteSupervisor(supervisor);

export interface ExecutionGuest extends PagedGuest {
  /** The sandbox ID. */
  readonly id: string;
  exec(command: string, stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
  run?(
    command: string,
    env: Record<string, string>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string>;
}

export async function execute(g: ExecutionGuest, input: ExecInput): Promise<ExecResult> {
  return pagedExecute({
    guest: g,
    input,
    fail: (message, code) => failure(message, code),
    launch: (root, signal) => {
      const spec = {
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        activityPath: input.activityPath,
      };

      const oneShot = guestSpec({ ...spec, envKeys: Object.keys(input.env) }).toString("hex");
      const command = launch.command(g.id, root, oneShot);

      if (g.run && input.stdin === undefined && Buffer.byteLength(command) < 96 * 1024)
        return g.run(command, input.env, input.timeoutMs + 5000, signal);

      return g.exec(
        launch.command(g.id, root),
        guestSpec({ ...spec, env: input.env, stdin: input.stdin ?? "" }).toString("hex"),
        input.timeoutMs + 5000,
        signal,
      );
    },
  });
}

import { guestSpec } from "../../shared/wire.js";
import type { ExecInput, ExecResult } from "../../provider.js";
import { guestProcess } from "../../shared/guest.js";
import { pagedExecute, type PagedGuest } from "../../shared/paged-exec.js";
import { quote } from "../../shared/shell.js";
import { failure } from "./errors.js";

export const supervisorPath = "/var/lib/sandbox-sdk-exec-v2.py";

// The one-shot launcher travels in the native exec request. Small results
// return inline; large output uses bounded native ranged reads.
export const supervisor = `import os,sys,marshal,_signal as signal,select,time,fcntl
${guestProcess}
root=sys.argv[1]
v=marshal.loads(bytes.fromhex(sys.argv[2])) if len(sys.argv)>2 else marshal.loads(bytes.fromhex(sys.stdin.read()))
if 'envKeys' in v: v['env']={k:os.environ[k] for k in v['envKeys']}
os.makedirs(root,mode=0o700,exist_ok=True)
# Keep small completed responses until their request deadline has passed.
# Sweep expired responses inline, so no ack RPC or background daemon is needed.
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
   stdout=p.stdout.fileno(); streams={stdout:'stdout',p.stderr.fileno():'stderr'}
   end=time.monotonic()+v['timeoutMs']/1000
   while streams or p.poll() is None:
    if not timed and time.monotonic()>=end:
     timed=True
     try: os.killpg(p.pid,signal.SIGKILL)
     except ProcessLookupError: pass
    for fd in select.select(list(streams),[],[],.01)[0]:
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
      const command = `python3 -S -c ${quote(supervisor)} ${quote(root)} ${quote(oneShot)}`;

      if (g.run && input.stdin === undefined && Buffer.byteLength(command) < 96 * 1024)
        return g.run(command, input.env, input.timeoutMs + 5000, signal);

      return g.exec(
        `python3 -S -c ${quote(supervisor)} ${quote(root)}`,
        guestSpec({ ...spec, env: input.env, stdin: input.stdin ?? "" }).toString("hex"),
        input.timeoutMs + 5000,
        signal,
      );
    },
  });
}

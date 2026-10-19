import type { ExecInput, ExecResult, FileInfo, ProviderFiles } from "../../provider.js";
import { SandboxError, type ErrorCode } from "../../errors.js";
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export interface Guest {
  name: string;
  raw(command: string): Promise<string>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
  destroy(): Promise<void>;
}
const fail = (g: Guest, text: string, code: ErrorCode = "provider") =>
  new SandboxError(`${text}. Check the ${g.name} sandbox before retrying.`, {
    code,
    provider: g.name,
  });
const python = (code: string, ...args: string[]) =>
  `python3 -c ${quote(code)} ${args.map(quote).join(" ")}`;
// Each record is <=22 KiB. User output never enters the native SDK's buffered
// exec response. A detached supervisor enforces the deadline even on disconnect.
const supervisor = `import os,sys,json,base64,subprocess,signal,selectors,time,tempfile
root=sys.argv[1]
with open(root+'/spec') as f: v=json.load(f)
os.unlink(root+'/spec')
with tempfile.TemporaryFile() as f, open(root+'/out','wb',buffering=0) as out:
 f.write(base64.b64decode(v['stdin'])); f.seek(0)
 p=subprocess.Popen(['sh','-c',v['command']],cwd=v['cwd'],env={**os.environ,**v['env']},stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 with open(root+'/pid','w') as m: m.write(str(p.pid))
 sel=selectors.DefaultSelector()
 sel.register(p.stdout,selectors.EVENT_READ,'stdout'); sel.register(p.stderr,selectors.EVENT_READ,'stderr')
 end=time.monotonic()+v['timeoutMs']/1000
 timed=False
 while sel.get_map() or p.poll() is None:
  if not timed and time.monotonic()>=end:
   timed=True
   try: os.killpg(p.pid,signal.SIGKILL)
   except ProcessLookupError: pass
  for key,_ in sel.select(.01):
   data=os.read(key.fd,16384)
   if data: out.write((json.dumps([key.data,base64.b64encode(data).decode()])+'\\n').encode())
   else: sel.unregister(key.fileobj); key.fileobj.close()
 code=p.wait()
 with open(root+'/exit','w') as m: json.dump({'exitCode':None if timed else (code if code>=0 else 128-code),'timedOut':timed},m)
`;
const page = `import sys,json,os
root=sys.argv[1]; pos=int(sys.argv[2]); chunks=[]
result=None
try:
 with open(root+'/exit') as f: result=json.load(f)
except (FileNotFoundError,ValueError): pass
try:
 with open(root+'/out','rb') as f:
  f.seek(pos)
  for _ in range(3):
   line=f.readline(24000)
   if not line.endswith(b'\\n'): break
   chunks.append(json.loads(line)); pos=f.tell()
except FileNotFoundError: pass
print(json.dumps(dict(offset=pos,chunks=chunks,result=result)))`;
export async function execute(g: Guest, input: ExecInput): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const dir = `/tmp/.sandbox-sdk/run-${crypto.randomUUID()}`;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const timer = setTimeout(cancel, input.timeoutMs);
  input.signal?.addEventListener("abort", cancel, { once: true });
  let launched = false;
  let settled = false;
  async function stop() {
    try {
      await g.raw(
        python(
          `import os,sys,time,signal
p=sys.argv[1]+'/pid'
for _ in range(500):
 try:
  with open(p) as f: pid=int(f.read())
  break
 except (FileNotFoundError,ValueError): time.sleep(.01)
else: raise RuntimeError('PID unavailable')
try: os.killpg(pid,signal.SIGKILL)
except ProcessLookupError: pass`,
          dir,
        ),
      );
    } catch {
      // Deleting the VM is the safe fallback when a launch/kill response is lost.
      try {
        await g.destroy();
      } catch {
        throw fail(
          g,
          "Process cancellation and VM deletion could not be confirmed",
          "outcome_unknown",
        );
      }
    }
  }
  try {
    await g.raw(
      `umask 077; mkdir -p /tmp/.sandbox-sdk; mkdir ${quote(dir)}; chmod 700 ${quote(dir)}; touch ${quote(dir + "/spec")}; chmod 600 ${quote(dir + "/spec")}`,
    );
    await g.upload(
      dir + "/spec",
      Buffer.from(
        JSON.stringify({
          command: input.command,
          cwd: input.cwd,
          env: input.env,
          stdin: Buffer.from(input.stdin ?? "").toString("base64"),
          timeoutMs: input.timeoutMs,
        }),
      ),
    );
    await g.raw(`chmod 600 ${quote(dir + "/spec")}`);
    await g.upload(dir + "/supervisor", Buffer.from(supervisor));
    if (cancelled || input.signal?.aborted) return { exitCode: null, timedOut: true };
    launched = true;
    await g.raw(
      `nohup python3 ${quote(dir + "/supervisor")} ${quote(dir)} </dev/null >/dev/null 2>&1 &`,
    );
    let offset = 0;
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    while (true) {
      if (cancelled || input.signal?.aborted) {
        await stop();
        settled = true;
        return { exitCode: null, timedOut: true };
      }
      const value: unknown = JSON.parse(await g.raw(python(page, dir, String(offset))));
      if (
        !value ||
        typeof value !== "object" ||
        !("offset" in value) ||
        typeof value.offset !== "number" ||
        !Number.isSafeInteger(value.offset) ||
        value.offset < offset ||
        !("chunks" in value) ||
        !Array.isArray(value.chunks) ||
        value.chunks.length > 3 ||
        !("result" in value)
      )
        throw fail(g, "Invalid command output page");
      const previous = offset;
      offset = value.offset;
      for (const chunk of value.chunks) {
        if (
          !Array.isArray(chunk) ||
          (chunk[0] !== "stdout" && chunk[0] !== "stderr") ||
          typeof chunk[1] !== "string" ||
          chunk[1].length > 21848
        )
          throw fail(g, "Invalid output record");
        const stream = chunk[0] === "stdout" ? "stdout" : "stderr";
        const text = decoders[stream].decode(Buffer.from(chunk[1], "base64"), { stream: true });
        if (text) input.onChunk({ stream, text });
      }
      if (value.result && offset === previous) {
        const r = value.result;
        if (
          typeof r !== "object" ||
          !("exitCode" in r) ||
          (r.exitCode !== null && typeof r.exitCode !== "number") ||
          !("timedOut" in r) ||
          typeof r.timedOut !== "boolean"
        )
          throw fail(g, "Invalid command exit result");
        for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
          const text = decoders[stream].decode();
          if (text) input.onChunk({ stream, text });
        }
        settled = true;
        return { exitCode: r.exitCode, timedOut: r.timedOut };
      }
      if (offset === previous) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } catch (error) {
    if (launched && !settled) await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    await g.raw(`rm -rf -- ${quote(dir)}`).catch(() => {});
  }
}
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
  const readRange = (id: string, path: string, options: { offset: number; length: number }) =>
    safe(id, async () => {
      const g = await get(id);
      const text = await g.raw(
        python(
          `import sys,base64
try:
 with open(sys.argv[1],'rb') as f:
  f.seek(int(sys.argv[2])); print(base64.b64encode(f.read(int(sys.argv[3]))).decode())
except FileNotFoundError: print('SDK_FILE_NOT_FOUND')`,
          path,
          String(options.offset),
          String(Math.min(options.length, 32768)),
        ),
      );
      if (text.trim() === "SDK_FILE_NOT_FOUND")
        throw fail(g, "File does not exist", "file_not_found");
      return new Uint8Array(Buffer.from(text.trim(), "base64"));
    });
  return {
    readRange,
    read: async (id, path) => {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      while (true) {
        const chunk = await readRange(id, path, { offset, length: 32768 });
        chunks.push(chunk);
        offset += chunk.length;
        if (chunk.length < 32768) break;
      }
      return new Uint8Array(Buffer.concat(chunks));
    },
    write: (id, path, data) =>
      safe(id, async () => {
        const g = await get(id);
        await g.raw(
          python("import os,sys; os.makedirs(os.path.dirname(sys.argv[1]),exist_ok=True)", path),
        );
        await g.upload(path, data);
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

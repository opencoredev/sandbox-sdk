/**
 * The guest programs every Buddy command runs under, the scripts that stage its input and cancel it, and
 * the host-side reader of its output.
 *
 * Buddy has two command routes (checked live, 2026-11-24). `POST /exec` runs one command and answers with
 * its stdout, stderr and exit code; it is not recorded in `GET /execs`, takes at most ~64 KiB of command,
 * and is cut at 60 seconds. `POST /execs` starts a command and records it, its command text and its merged,
 * line-split output (`\r` dropped) in `GET /execs`; it takes 16 KiB of command and runs up to 90 minutes.
 *
 * So the adapter's own short steps (staging, cancels, metadata) run on `POST /exec`, and every user
 * command runs on `POST /execs` under a constant launcher that carries no environment value, no stdin and
 * no long command: those are written first into a private directory through `POST /exec`. The launcher
 * starts {@link bridge}, which runs the command in a session of its own and writes every chunk of output as
 * one numbered line (`<seq>:O:<base64>`, `<seq>:E:<base64>`, then `<seq>:X:<exit code>`) to its stdout and
 * to a spool file. The host reads Buddy's log, and reads the spool when the log has a gap, is cut, or ends
 * without the exit frame.
 */
import { createHash } from "node:crypto";
import { SandboxError } from "../../errors.js";
import type { OutputChunk } from "../../provider.js";
import { quote } from "../../shared/shell.js";
import { provider } from "./errors.js";

/** Where each command's private directory lives. */
export const execRoot = "/tmp/.sandbox-sdk/exec";

/** Where a sandbox's stable command environments live, one 0600 file per distinct environment. */
export const envRoot = "/tmp/.sandbox-sdk/env";

/** Markers {@link bridge} and the launcher print before anything ran, so the command can be sent again. */
export const notStarted = {
  bridge: "SANDBOX_SDK_NO_BRIDGE",
  stage: "SANDBOX_SDK_NO_STAGE",
} as const;

/**
 * The command's own shell (argv: dir, cwd, command), the leader of its new session. Under the command's
 * lock it checks the cancel marker (a cancelled start writes `refused` and exits 137 without running
 * anything) and records its own PID, which is its process group, before it runs the command. The lock is
 * released before the command runs.
 */
const start = [
  `exec 9>>"$1/lock" && "$5" -w 30 9 || { echo "sandbox-sdk: cannot take the command lock" >&2; exit 125; }`,
  `if [ -e "$1/cancel" ]; then : > "$1/refused"; exit 137; fi`,
  `echo $$ > "$1/pid.tmp" && "$6" -f "$1/pid.tmp" "$1/pid" || { echo "sandbox-sdk: cannot record the command" >&2; exit 125; }`,
  `exec 9>&-`,
  `cd -- "$2" || exit 1`,
  `if [ "$3" = "f" ]; then exec "$7" "$1/cmd"; else exec "$7" -c "$4"; fi`,
].join("\n");

/**
 * Runs one command: argv is `dir cwd activityPath envFile staged finished [command]`, where `dir` is the
 * command's private directory under {@link execRoot} and `finished` names (comma-separated) earlier
 * commands of this client whose directories it removes, once their `done` marker shows they ended. `staged` lists the files
 * staged in the command's directory: `e` env.json, `s` stdin, `c` the command (when it is not in argv).
 * A missing staged file, or a missing shared env file, prints {@link notStarted}.stage and exits 125
 * before anything ran.
 *
 * The command's own shell, started in a new session (`start_new_session`, so its PID is its process
 * group), takes the command's lock, checks the cancel marker, and records its own PID before it runs the
 * command: a refused start leaves `refused` instead. {@link killer} takes the same lock to write the
 * marker and read the PID, so a cancel either stops the command from starting or finds its group, even
 * when the bridge itself is killed right after the spawn. Output
 * is framed and numbered from frame 0, appended to `spool` and written to stdout without blocking: once
 * stdout cannot take a whole frame, the bridge stops writing it and the host reads the spool. `done` is
 * written at exit. Directories no client named are swept after 10 minutes, abandoned ones after 2 days.
 */
export const bridge = `import base64,json,os,re,selectors,shutil,subprocess,sys,time
start=${JSON.stringify(start)}
d,cwd,act,envf,staged,finished=sys.argv[1:7]
cmd=sys.argv[7] if len(sys.argv)>7 else None
root,tag=os.path.split(d)
os.umask(0o077)
os.makedirs(d,mode=0o700,exist_ok=True)
for f in finished.split(','):
 if re.fullmatch('[0-9a-f-]{36}',f) and f!=tag and os.path.exists(root+'/'+f+'/done'): shutil.rmtree(root+'/'+f,ignore_errors=True)
now=time.time()
try:
 for e in os.scandir(root):
  if e.name==tag: continue
  try: t=os.stat(e.path+'/done').st_mtime+600
  except OSError:
   try: t=os.stat(e.path).st_mtime+172800
   except OSError: continue
  if now>t: shutil.rmtree(e.path,ignore_errors=True)
except OSError: pass
def missing():
 print('${notStarted.stage}',flush=True)
 sys.exit(125)
sys_sh=shutil.which('sh') or '/bin/sh'
sys_flock=shutil.which('flock') or 'flock'
sys_mv=shutil.which('mv') or 'mv'
env=dict(os.environ)
try:
 if envf:
  with open(envf,'rb') as h: env.update(json.loads(h.read().decode()))
 if 'm' in staged:
  with open(d+'/meta.json','rb') as h: m=json.loads(h.read().decode())
  os.unlink(d+'/meta.json')
  cwd,act=m['cwd'],m['act']
 if 'e' in staged:
  with open(d+'/env.json','rb') as h: env.update(json.loads(h.read().decode()))
  os.unlink(d+'/env.json')
 if 'c' in staged:
  if not os.path.isfile(d+'/cmd'): missing()
 if 's' in staged:
  si=open(d+'/stdin','rb')
  os.unlink(d+'/stdin')
 else: si=open(os.devnull,'rb')
except (FileNotFoundError,ValueError): missing()
if 'c' not in staged and cmd is None: missing()
sp=os.open(d+'/spool',os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
n=0
live=True
try: os.set_blocking(1,False)
except OSError: pass
def emit(k,v):
 global n,live
 b=('%d:%s:%d:%s.\\n'%(n,k,len(v),v)).encode()
 n+=1
 w=0
 while w<len(b): w+=os.write(sp,b[w:])
 if live:
  try: live=os.write(1,b)==len(b)
  except OSError: live=False
code=137
p=None
if act and not os.path.exists(d+'/cancel'):
 os.makedirs(os.path.dirname(act),exist_ok=True)
 with open(act,'w') as f: f.write('1')
argv=[sys_sh,'-c',start,'sh',d,cwd,'f','',sys_flock,sys_mv,sys_sh] if 'c' in staged else [sys_sh,'-c',start,'sh',d,cwd,'c',cmd,sys_flock,sys_mv,sys_sh]
try:
 p=subprocess.Popen(argv,env=env,stdin=si,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
except OSError as e:
 emit('E',base64.b64encode(('sandbox-sdk: cannot start the command: %s\\n'%e.strerror).encode()).decode())
 code=126
try:
 if p:
  s=selectors.DefaultSelector()
  s.register(p.stdout,selectors.EVENT_READ,'O')
  s.register(p.stderr,selectors.EVENT_READ,'E')
  while s.get_map():
   for key,_ in s.select():
    b=os.read(key.fileobj.fileno(),4096)
    if b: emit(key.data,base64.b64encode(b).decode())
    else: s.unregister(key.fileobj)
  r=p.wait()
  code=r if r>=0 else 128-r
 emit('X',str(code))
 try: open(d+'/done','w').close()
 except OSError: pass
finally:
 if 'c' in staged:
  try: os.unlink(d+'/cmd')
  except FileNotFoundError: pass
 if act:
  try: os.unlink(act)
  except FileNotFoundError: pass
sys.exit(code)
`;

/** The bridge's file, named by its content, so a sandbox can hold the bridges of several SDK versions. */
export const bridgePath = `/tmp/.sandbox-sdk/bin/buddy-bridge-${createHash("sha256").update(bridge).digest("hex").slice(0, 16)}.py`;

/** Shell that installs the bridge when it is missing. */
export const installBridge = `[ -f ${bridgePath} ] || { mkdir -p /tmp/.sandbox-sdk/bin && printf %s ${quote(
  Buffer.from(bridge).toString("base64"),
)} | base64 -d > ${bridgePath}.$$ && mv -f ${bridgePath}.$$ ${bridgePath}; } || exit 1`;

/** Commands up to this size travel in the launcher; longer ones are staged. */
export const inlineCommandBytes = 4096;

/** Buddy's documented and probed limit on the `POST /execs` command string. */
export const maxAsyncCommandBytes = 16 * 1024;

/**
 * The `POST /execs` command: the only text Buddy records. It names the bridge, the tag, the working
 * directory, the activity path, the shared env file and which files are staged, and an inline command of
 * at most {@link inlineCommandBytes}. No environment value or stdin is ever part of it.
 */
export function launcher(input: {
  tag: string;
  cwd: string;
  activityPath: string | undefined;
  envFile: string | undefined;
  staged: string;
  /** Earlier commands of this client that ended, whose directories the bridge removes. */
  finished: readonly string[];
  command: string | undefined;
}): string {
  const args = [
    `${execRoot}/${input.tag}`,
    input.cwd,
    input.activityPath ?? "",
    input.envFile ?? "",
    input.staged,
    input.finished.join(","),
    ...(input.command === undefined ? [] : [input.command]),
  ].map(quote);

  return `[ -f ${bridgePath} ] || { echo ${notStarted.bridge}; exit 125; }; exec setsid -w python3 -u ${bridgePath} ${args.join(" ")}`;
}

/** One file to write in the guest, privately (umask 077), and moved into place once whole. */
export interface StagedFile {
  path: string;
  bytes: Uint8Array;
}

/** Raw bytes per staging chunk: about 40 KiB of base64, under the ~64 KiB `POST /exec` takes. */
const chunkBytes = 30 * 1024;

/** Largest staging command; `POST /exec` answered a 256 KiB command with empty output (2026-11-24). */
const maxStageCommand = 44 * 1024;

/**
 * Commands for `POST /exec` that write `files` privately: each into `<path>.part` in base64 chunks, then
 * all moved into place by the last command. `prelude` (a private directory, the bridge) runs first.
 * When `lockTag` is given, every chunk acquires the command's lock and refuses to write if its cancel
 * marker already exists, so a late staging request cannot recreate private input after cancellation.
 */
export function stageCommands(
  prelude: string,
  files: readonly StagedFile[],
  lockTag?: string,
): string[] {
  const dir = lockTag === undefined ? undefined : `${execRoot}/${lockTag}`;

  const header =
    dir === undefined
      ? "umask 077"
      : `umask 077; mkdir -p ${execRoot} && { [ -d ${quote(dir)} ] || mkdir -m 700 ${quote(dir)}; } && exec 9>>${quote(`${dir}/lock`)} && flock -w 10 9 && [ ! -e ${quote(`${dir}/cancel`)} ] || exit 137`;

  const commands: string[] = [];
  let current = `${header}; ${prelude}`;

  const push = (line: string) => {
    if (current.length + line.length + 2 > maxStageCommand) {
      commands.push(current);
      current = header;
    }

    current += `; ${line}`;
  };

  for (const file of files) {
    const part = quote(`${file.path}.part`);

    if (file.bytes.length === 0) push(`: > ${part} || exit 1`);

    for (let offset = 0; offset < file.bytes.length; offset += chunkBytes) {
      const chunk = Buffer.from(file.bytes.subarray(offset, offset + chunkBytes)).toString(
        "base64",
      );

      push(`printf %s ${quote(chunk)} | base64 -d ${offset === 0 ? ">" : ">>"} ${part} || exit 1`);
    }
  }

  for (const file of files)
    push(`mv -f ${quote(`${file.path}.part`)} ${quote(file.path)} || exit 1`);
  commands.push(current);

  return commands;
}

/** Shell that makes a command's private directory. */
export const commandDir = (tag: string) =>
  `mkdir -p ${execRoot} && { [ -d ${quote(`${execRoot}/${tag}`)} ] || mkdir -m 700 ${quote(`${execRoot}/${tag}`)}; } || exit 1`;

/** Shell that makes the private directory of shared env files. */
export const envDir = `mkdir -p ${envRoot} && chmod 700 ${envRoot} || exit 1`;

/**
 * Cancels one command: argv is `tag [keep]`. Under the command's lock it writes the cancel marker, then
 * reads the PID record, and prints what it found as one word on stdout:
 *
 * - `pending`: no record, so the command has not started, and the marker now stops it. Staged input that
 *   nothing will read (env, stdin, a long command) is removed. Exits 0.
 * - `refused`: no record, and the command's shell saw the marker and ran nothing. Exits 0.
 * - `killed`: the group was killed and `kill -0` answers "No such process" for it. Exits 0 after removing
 *   the command's directory, unless `keep` is given (the host reads the spool first, then removes it).
 *
 * A record that is not a plain number above 1, any other `kill -0` answer, or a group alive after about
 * five seconds exits 1 and keeps the directory. Commands run as Buddy's `buddy` user, which has
 * passwordless sudo, so a command can start root-owned processes in its group: when `sudo -n` works every
 * signal and check goes through it. A marker it cannot write exits 1: it would not stop a late start.
 */
export const killer = [
  `d=${execRoot}/$1`,
  `keep=$2`,
  `umask 077`,
  `mkdir -p "$d" 2>/dev/null || exit 1`,
  `exec 9>>"$d/lock" || exit 1`,
  `flock -w 10 9 || exit 1`,
  `{ : > "$d/cancel"; } 2>/dev/null || exit 1`,
  `p=`,
  `read -r p < "$d/pid" 2>/dev/null`,
  `if [ -z "$p" ]; then`,
  `  rm -f "$d/env.json" "$d/stdin" "$d/cmd" "$d/meta.json" "$d/env.json.part" "$d/stdin.part" "$d/cmd.part" "$d/meta.json.part" 2>/dev/null`,
  `  if [ -e "$d/refused" ]; then echo refused; else echo pending; fi`,
  `  exit 0`,
  `fi`,
  `flock -u 9`,
  `case $p in *[!0-9]* | 0*) exit 1 ;; esac`,
  `[ "$p" -gt 1 ] || exit 1`,
  `u=; sudo -n true 2>/dev/null && u=1`,
  `k() { if [ -n "$u" ]; then sudo -n kill "$1" -- -"$p"; else kill "$1" -"$p"; fi; }`,
  `gone() { e=$(k -0 2>&1) && return 1; case $e in *"No such process"*) return 0;; esac; return 2; }`,
  `i=0`,
  `while :; do`,
  `  k -KILL 2>/dev/null`,
  `  gone; r=$?`,
  `  [ "$r" -eq 0 ] && break`,
  `  [ "$r" -eq 1 ] && [ "$i" -lt 100 ] || exit 1`,
  `  i=$((i + 1)); sleep 0.05`,
  `done`,
  // The command's group is gone and it is past its start: nothing of it can run again.
  `[ -n "$keep" ] || rm -rf "$d"`,
  `echo killed`,
  `exit 0`,
].join("\n");

/** What {@link killer} found: see there. `gone`: the sandbox itself is gone. */
export type KillState = "pending" | "refused" | "killed" | "gone";

export function parseKillState(stdout: string): KillState | undefined {
  const word = stdout.trim();

  return word === "pending" || word === "refused" || word === "killed" ? word : undefined;
}

/** The `POST /exec` command that cancels the command `tag`, in a session of its own. */
export const killCommand = (tag: string, keep = false) =>
  `setsid -w sh -c ${quote(killer)} sh ${quote(tag)}${keep ? " keep" : ""}`;

/** Removes a command's private directory. */
export const removeCommand = (tag: string) => `rm -rf ${quote(`${execRoot}/${tag}`)}`;

/** Largest spool read per `POST /exec`, in raw bytes. */
export const spoolReadBytes = 1024 * 1024;

/**
 * Reads a command's spool from a byte offset: prints `<done>:<more>:<base64>`, where `done` is 1 once the
 * bridge finished and `more` is 1 when bytes remain past this read; `missing` when there is no spool.
 */
export const spoolCommand = (tag: string, offset: number) =>
  `python3 -c ${quote(
    [
      "import base64,os,sys",
      "d=sys.argv[1]",
      "o=int(sys.argv[2])",
      "n=int(sys.argv[3])",
      "done=os.path.exists(d+'/done')",
      "try: f=open(d+'/spool','rb')",
      "except FileNotFoundError:",
      " print('missing')",
      " sys.exit(0)",
      "f.seek(o)",
      "b=f.read(n)",
      "more=len(f.read(1))>0",
      "sys.stdout.write('%d:%d:%s'%(done,more,base64.b64encode(b).decode()))",
    ].join("\n"),
  )} ${quote(`${execRoot}/${tag}`)} ${offset} ${spoolReadBytes}`;

/** A read of the spool. */
export type SpoolRead =
  | { kind: "missing" }
  | { kind: "bytes"; bytes: Uint8Array; done: boolean; more: boolean };

export function parseSpool(text: string): SpoolRead | undefined {
  const trimmed = text.trim();

  if (trimmed === "missing") return { kind: "missing" };
  const match = /^([01]):([01]):([A-Za-z0-9+/]*={0,2})$/.exec(trimmed);

  if (!match) return undefined;

  return {
    kind: "bytes",
    bytes: Buffer.from(match[3] ?? "", "base64"),
    done: match[1] === "1",
    more: match[2] === "1",
  };
}

/** The spool, which only the bridge writes, broke the framing: the exact output cannot be recovered. */
export class FrameError extends SandboxError {
  constructor(sandboxId: string) {
    super(
      "Buddy: the command's output spool is malformed, so its exact output could not be recovered. Retry the command.",
      { code: "provider", provider, sandboxId },
    );
  }
}

/** What feeding one line to the {@link FrameReader} found. */
export type LineVerdict = "ok" | "gap";

const framePattern = /^(\d{1,12}):([OEX]):(\d{1,6}):(.*)\.$/;
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;

/** Longest frame line: 4096 bytes of base64 plus the sequence, tag, length, and terminator. */
const maxFrame = 5600;

/**
 * Decodes the bridge's frames in sequence, from Buddy's log or the spool. A frame already seen is skipped,
 * so both sources can overlap. In the log, a line out of sequence or malformed means the log lost or broke
 * a frame: `gap` sends the reader to the spool. Lines before the first frame are the launcher's own (a
 * not-started marker); after it, Buddy's log carries only frames, and anything else there is ignored.
 */
export class FrameReader {
  #next = 0;
  #exit: number | undefined;
  #framed = false;
  readonly preface: string[] = [];

  readonly #decoders = {
    stdout: new TextDecoder("utf-8", { ignoreBOM: true }),
    stderr: new TextDecoder("utf-8", { ignoreBOM: true }),
  };

  readonly #emit: (chunk: OutputChunk) => void;
  readonly #sandboxId: string;

  constructor(emit: (chunk: OutputChunk) => void, sandboxId: string) {
    this.#emit = emit;
    this.#sandboxId = sandboxId;
  }

  /** The next frame number the reader needs. */
  get next() {
    return this.#next;
  }

  /** The command's exit code, once the exit frame arrived. */
  get exitCode() {
    return this.#exit;
  }

  /** Whether any frame arrived: the bridge started. */
  get framed() {
    return this.#framed;
  }

  #broken(): never {
    throw new FrameError(this.#sandboxId);
  }

  line(text: string, source: "log" | "spool"): LineVerdict {
    if (this.#exit !== undefined) return "ok";
    const frame = framePattern.exec(text);

    if (!frame) {
      if (source === "spool") this.#broken();

      // A frame broken by a partial pipe write (even frame 0): the spool holds the complete frame.
      if (/^\d+:[OEX]:/.test(text)) return "gap";

      if (!this.#framed) {
        if (this.preface.length < 20) this.preface.push(text.slice(0, 200));

        return "ok";
      }

      return "ok";
    }

    const seq = Number(frame[1]);
    const kind = frame[2];
    const declaredLength = Number(frame[3]);
    const value = frame[4] ?? "";

    if (value.length !== declaredLength) return source === "spool" ? this.#broken() : "gap";

    if (seq < this.#next) return "ok";

    if (seq > this.#next) {
      if (source === "spool") this.#broken();

      return "gap";
    }

    if (kind === "X") {
      if (!/^\d{1,3}$/.test(value)) return source === "spool" ? this.#broken() : "gap";
      this.#next++;
      this.#framed = true;

      for (const stream of ["stdout", "stderr"] as const) {
        const rest = this.#decoders[stream].decode();

        if (rest) this.#emit({ stream, text: rest });
      }

      this.#exit = Number(value);

      return "ok";
    }

    if (
      text.length > maxFrame ||
      !base64Pattern.test(value) ||
      Buffer.from(value, "base64").toString("base64") !== value
    )
      return source === "spool" ? this.#broken() : "gap";
    this.#next++;
    this.#framed = true;
    const stream = kind === "O" ? "stdout" : "stderr";
    const decoded = this.#decoders[stream].decode(Buffer.from(value, "base64"), { stream: true });

    if (decoded) this.#emit({ stream, text: decoded });

    return "ok";
  }
}

/** Splits spool bytes into whole lines, keeping a partial last line for the next read. */
export class LineSplitter {
  #pending = "";
  readonly #decoder = new TextDecoder("utf-8");
  readonly #sandboxId: string;

  constructor(sandboxId: string) {
    this.#sandboxId = sandboxId;
  }

  push(bytes: Uint8Array): string[] {
    const lines: string[] = [];

    for (let start = 0; start < bytes.length;) {
      const nl = bytes.indexOf(10, start);
      const end = nl === -1 ? bytes.length : nl;

      if (end - start > maxFrame * 4) {
        this.#pending = "";
        throw new FrameError(this.#sandboxId);
      }

      const chunk = this.#decoder.decode(bytes.subarray(start, end), { stream: nl === -1 });

      if (this.#pending.length + chunk.length > maxFrame) {
        this.#pending = "";
        throw new FrameError(this.#sandboxId);
      }

      if (nl === -1) {
        this.#pending += chunk;

        break;
      }

      lines.push(this.#pending + chunk);
      this.#pending = "";
      start = nl + 1;
    }

    return lines;
  }

  get pending() {
    return this.#pending;
  }
}

/** Buddy's hard limit on one `POST /execs` command, in minutes (`failure_reason: TIMEOUT`). */
export const maxCommandMinutes = 90;

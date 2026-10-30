import { posix, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as local } from "node:fs";
import type { Provider, FileEvent, FileInfo, WriteOptions } from "./provider.js";
import { SandboxError, invalid, isNotFound, type ErrorCode, type Redactor } from "./errors.js";
import { neverSent } from "./http.js";
import { pathOf, defaults } from "./run.js";
import { quote } from "./shared/shell.js";
import { isObject, isString } from "./shared/narrow.js";

export type { FileEvent };

export interface FileDiff {
  added: string[];
  modified: string[];
  removed: string[];
  patch: string;
}

export interface Files {
  read(path: string): Promise<string>;
  read(path: string, options: { as: "bytes" }): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array, options?: WriteOptions): Promise<void>;
  write(files: Record<string, string | Uint8Array>, options?: WriteOptions): Promise<void>;
  edit(path: string, edit: { find: string; replace: string }): Promise<void>;
  list(path?: string, options?: { recursive?: boolean; glob?: string }): Promise<FileInfo[]>;
  stat(path: string): Promise<FileInfo>;
  exists(path: string): Promise<boolean>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  upload(source: string, target: string, options?: { ignore?: string[] }): Promise<void>;
  download(source: string, target: string): Promise<void>;
  search(
    query: string,
    options?: { path?: string; glob?: string; maxMatches?: number },
  ): Promise<{ path: string; line: number; text: string }[]>;
  watch(
    path: string,
    callback: (event: FileEvent) => void,
    options?: { recursive?: boolean; intervalMs?: number; onError?: (error: SandboxError) => void },
  ): () => void;
  mark(name?: string): Promise<string>;
  changes(options?: { since?: string }): Promise<FileDiff>;
}

/** A unified diff hunk that replaces a whole file. undefined content means the file is absent. */
function wholeFilePatch(path: string, before: string | undefined, after: string | undefined) {
  const lines = (text: string | undefined) => (text ? text.replace(/\n$/, "").split("\n") : []);
  const oldLines = lines(before);
  const newLines = lines(after);

  const noNewline = (text: string | undefined, count: number) =>
    count && !text?.endsWith("\n") ? "\\ No newline at end of file\n" : "";

  return [
    `--- ${before === undefined ? "/dev/null" : `a/${path}`}\n`,
    `+++ ${after === undefined ? "/dev/null" : `b/${path}`}\n`,
    `@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n`,
    ...oldLines.map((line) => `-${line}\n`),
    noNewline(before, oldLines.length),
    ...newLines.map((line) => `+${line}\n`),
    noNewline(after, newLines.length),
  ].join("");
}

/** @internal Remove a file; one that is already gone is not an error. Some adapters report
 * a missing path as a generic provider error, so a stat confirms that case. */
export async function removeIfPresent(files: Pick<Files, "remove" | "exists">, path: string) {
  try {
    await files.remove(path);
  } catch (error) {
    if (isNotFound(error)) return;

    if (error instanceof SandboxError && error.code === "provider" && !(await files.exists(path)))
      return;
    throw error;
  }
}

/** Whether a write argument is file content rather than write options. */
function isContent(
  value: string | Uint8Array | WriteOptions | undefined,
): value is string | Uint8Array {
  return isString(value) || value instanceof Uint8Array;
}

const globParts = (glob: string) => glob.split(/(\*\*\/|\*\*|\*|\?)/);

export function globMatch(path: string, glob: string) {
  const pattern = globParts(glob)
    .map((part) =>
      part === "**/"
        ? "(?:.*/)?"
        : part === "**"
          ? ".*"
          : part === "*"
            ? "[^/]*"
            : part === "?"
              ? "."
              : part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"),
    )
    .join("");

  return (
    new RegExp(`^${pattern}$`).test(path) ||
    (!glob.includes("/") && new RegExp(`^${pattern}$`).test(posix.basename(path)))
  );
}

// The same pattern for Python's re.fullmatch over UTF-16 code units: `.` excludes JS line terminators and every literal is a \u escape.
function pythonGlob(glob: string) {
  const any = "[^\\n\\r\\u2028\\u2029]";

  const literal = (text: string) =>
    Array.from(
      { length: text.length },
      (_, index) => `\\u${text.charCodeAt(index).toString(16).padStart(4, "0")}`,
    ).join("");

  return globParts(glob)
    .map((part) =>
      part === "**/"
        ? `(?:${any}*/)?`
        : part === "**"
          ? `${any}*`
          : part === "*"
            ? "[^/]*"
            : part === "?"
              ? any
              : literal(part),
    )
    .join("");
}

// Guest scripts are fixed source: every caller value (paths, globs, limits, user text) arrives as one
// JSON object in the environment, never in the command or argv. Environment values travel with the exec
// request, while stdin costs extra round trips on E2B and Upstash; input over 32 KiB goes on stdin, since
// one variable must stay under the kernel's 128 KiB limit. Exit 70 means "use the RPC path": it is raised
// before any change, so the fallback reproduces each provider's own errors exactly.
// edit: read and count matches, then write the way the adapter's own write does. "in-place" rewrites the
// same inode (owner, mode and links stay); if that write fails, the original bytes go back before exit 70,
// and 71 means they could not. "replace" writes a sibling temp file with the original owner and mode and
// renames it over the target; hard-linked files stay in place (70). Symlinks resolve to their target.
const editScript = `import json,os,stat,sys
try:
 a=json.loads(os.environ.get("SANDBOX_SDK_INPUT") or sys.stdin.buffer.read());p=os.path.realpath(a["path"]);f=a["find"].encode();r=a["replace"].encode();w=a["write"]
 s=os.stat(p)
 if not stat.S_ISREG(s.st_mode) or (w!="in-place" and s.st_nlink>1):sys.exit(70)
 with open(p,"rb") as h:d=h.read()
except Exception:sys.exit(70)
m=[];n=1;q=0;i=d.find(f)
while i>=0:n+=d.count(b"\\n",q,i);q=i;m.append(n);i=d.find(f,i+1)
if len(m)!=1:print(" ".join(map(str,m)));sys.exit(3)
i=d.find(f);o=d[:i]+r+d[i+len(f):]
def put(fd,b):
 os.lseek(fd,0,0);v=memoryview(b)
 while v:v=v[os.write(fd,v):]
 os.ftruncate(fd,len(b))
if w=="in-place":
 try:fd=os.open(p,os.O_WRONLY)
 except Exception:sys.exit(70)
 try:put(fd,o)
 except Exception:
  try:put(fd,d)
  except Exception:sys.exit(71)
  sys.exit(70)
 sys.exit(0)
t="%s/.%s.%s.sdk-edit"%(os.path.dirname(p),os.path.basename(p),os.urandom(6).hex())
try:fd=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
except Exception:sys.exit(70)
try:
 with os.fdopen(fd,"wb") as h:h.write(o)
 if (s.st_uid,s.st_gid)!=(os.geteuid(),os.getegid()):os.chown(t,s.st_uid,s.st_gid)
 os.chmod(t,stat.S_IMODE(s.st_mode));os.rename(t,p)
except Exception:
 os.unlink(t);sys.exit(70)`;

// search: list the whole tree first in the adapter's list order (lstat types, like the RPC walk), then
// read regular files in that order and print [path, line, base64 line] for each line holding the query
// bytes, up to the limit. The glob arrives as a regular expression in the input and is only compiled.
const searchScript = `import base64,json,os,re,stat,sys
def u(s):
 if all(c<="\\uffff" for c in s):return s
 b=s.encode("utf-16-le","surrogatepass");return "".join(chr(int.from_bytes(b[i:i+2],"little")) for i in range(0,len(b),2))
files=[]
def walk(d,rel):
 names=os.listdir(d)
 for b in sorted(names) if order=="name" else names:
  p=os.path.join(d,b);s=os.lstat(p);name=b.decode("utf-8","replace");r=rel+name
  if stat.S_ISREG(s.st_mode) and (g is None or g.fullmatch(u(r)) or (base and g.fullmatch(u(name)))):files.append((p,os.path.join(root,r)))
  elif stat.S_ISDIR(s.st_mode):walk(p,r+"/")
try:
 a=json.loads(os.environ.get("SANDBOX_SDK_INPUT") or sys.stdin.buffer.read())
 root=a["root"];q=a["query"].encode();g=re.compile(a["pattern"]) if a["pattern"] else None;base=a["base"]is True;mx=int(a["max"]);order=a["order"]
 walk(os.fsencode(root),"");n=0
 for p,shown in files:
  with open(p,"rb") as h:lines=h.read().split(b"\\n")
  for i,line in enumerate(lines):
   if q in line:
    print(json.dumps([shown,i+1,base64.b64encode(line).decode()]));n+=1
    if n>=mx:sys.exit(0)
except Exception:sys.exit(70)`;

// Text the guest compares as UTF-8 bytes must decode to itself: no lone surrogates, BOM or replacement character.
const byteExact = (text: string) => !/\p{Cs}|[\uFEFF\uFFFD]/u.test(text);

// A path with a lone surrogate names different bytes in the guest than through the RPC path.
const wellFormed = (text: string) => !/\p{Cs}/u.test(text);

/** The one command a guest script runs as. It holds no caller value. */
const python = (script: string) => `python3 -I -S -c ${quote(script)}`;

/** Edit input: the target, the exact text and the adapter's write semantics. */
interface EditInput {
  path: string;
  find: string;
  replace: string;
  write: "in-place" | "replace";
}

/** Search input: `pattern` is the glob as a Python regular expression, empty for none. */
interface SearchInput {
  root: string;
  query: string;
  pattern: string;
  base: boolean;
  max: number;
  order: "name" | "directory";
}

// Refusals an adapter reports before anything starts in the guest.
const refusedCodes = new Set<ErrorCode>([
  "auth",
  "invalid_argument",
  "unsupported",
  "quota",
  "not_found",
]);

/** Whether an exec rejection proves the command never started: refused up front, or never sent. */
const neverRan = (cause: unknown) =>
  neverSent(cause) || (cause instanceof SandboxError && refusedCodes.has(cause.code));

const editFailed = (path: string, lines: number[]) =>
  new SandboxError(
    `Edit failed at ${path}. ${lines.length ? `Matches on lines ${lines.join(", ")}` : "Text not found"}. Supply a unique exact match.`,
    { code: lines.length ? "edit_not_unique" : "edit_not_found" },
  );

/** One guest search row: the shown path, its 1-based line, and the line's bytes in base64. */
function isSearchRow(value: unknown): value is [string, number, string] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    isString(value[0]) &&
    Number.isSafeInteger(value[1]) &&
    isString(value[2])
  );
}

// Ranged reads behind each SDK Files object. The public read has no range, so agent tools reach it here.
const boundedReads = new WeakMap<Files, (path: string, maxBytes: number) => Promise<Uint8Array>>();

/** @internal Read at most `maxBytes + 1` bytes when the adapter has ranged reads, so a caller can
 * refuse an oversized file without downloading all of it. Without them, read the whole file. */
export function readAtMost(files: Files, path: string, maxBytes: number) {
  const bounded = boundedReads.get(files);

  return bounded ? bounded(path, maxBytes) : files.read(path, { as: "bytes" });
}

/** `guard` throws synchronously when the handle is closed; `ready` resolves once the handle may touch the sandbox (secret recovery). */
export function makeFiles(
  provider: Provider,
  id: string,
  redactor: Redactor,
  guard: () => void = () => {},
  ready: () => Promise<void> = async () => {},
): Files & Disposable {
  const fs = provider.files;
  const watchers = new Set<() => void>();
  const hostExec = promisify(execFile);

  async function remote(command: string) {
    const result = await provider.exec(id, {
      command,
      cwd: "/workspace",
      env: defaults,
      timeoutMs: 120_000,
      onChunk() {},
    });

    if (result.exitCode !== 0)
      throw new SandboxError(
        "File transfer failed. The remote archive command failed. Ensure tar is installed and paths are accessible.",
        { code: "provider" },
      );
  }

  // One guest round trip. A guest without python3 (126/127) uses the RPC paths from then on; any
  // other failure before the guest commits a change falls back for this call only.
  let guestPython = provider.name !== "memory";

  // A stopped guest edit may already have renamed its file, so only read-only calls fall back after one.
  async function guest(
    script: string,
    value: EditInput | SearchInput,
    mutates: boolean,
  ): Promise<{ exitCode: number; stdout: string }> {
    if (!guestPython) return { exitCode: 70, stdout: "" };
    let stdout = "";
    const input = JSON.stringify(value);
    const inline = Buffer.byteLength(input) <= 32_768;
    const accepts = (await fs.guestInput?.(id)) ?? "stdin";

    if (accepts === "none" || (accepts === "env" && !inline)) return { exitCode: 70, stdout: "" };

    let result: Awaited<ReturnType<Provider["exec"]>>;

    try {
      result = await provider.exec(id, {
        command: python(script),
        cwd: "/",
        env: { ...defaults, SANDBOX_SDK_INPUT: inline ? input : "" },
        stdin: inline ? undefined : input,
        timeoutMs: 120_000,
        onChunk(chunk) {
          if (chunk.stream === "stdout") stdout += chunk.text;
        },
      });
    } catch (error) {
      // An edit may have committed before a timeout, a cut stream or a lost answer, so a retry could apply it twice.
      if (!mutates || neverRan(error)) throw error;
      throw new SandboxError(
        "File edit outcome unknown. The guest command may have run before the call failed. Read the file to check its state before retrying.",
        {
          code: "outcome_unknown",
          provider: provider.name,
          sandboxId: id,
          cause: redactor.error(error, provider.name, id),
        },
      );
    }

    if (result.timedOut || result.exitCode === null || result.exitCode >= 128) {
      if (!mutates) return { exitCode: 70, stdout: "" };
      throw new SandboxError(
        "File edit outcome unknown. The guest command was stopped before it reported. Read the file to check its state before retrying.",
        { code: "outcome_unknown" },
      );
    }

    if (result.exitCode === 126 || result.exitCode === 127) guestPython = false;

    return { exitCode: result.exitCode, stdout };
  }

  const safe = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      guard();
      await ready().finally(guard);

      return await action();
    } catch (error) {
      throw redactor.error(error, provider.name, id);
    }
  };

  async function list(
    path = ".",
    options: { recursive?: boolean; glob?: string } = {},
  ): Promise<FileInfo[]> {
    const root = pathOf(path);
    const result: FileInfo[] = [];

    async function visit(dir: string) {
      for (const entry of await fs.list(id, dir)) {
        if (!options.glob || globMatch(posix.relative(root, entry.path), options.glob))
          result.push(entry);

        if (options.recursive && entry.type === "directory") await visit(entry.path);
      }
    }

    await visit(root);

    return result;
  }

  async function read(path: string): Promise<string>;
  async function read(path: string, options: { as: "bytes" }): Promise<Uint8Array>;
  async function read(path: string, options?: { as: "bytes" }): Promise<string | Uint8Array> {
    const bytes = await safe(() => fs.read(id, pathOf(path)));

    // File reads are data, not output logs. Preserve exact contents (including binary).
    return options?.as === "bytes" ? bytes : new TextDecoder().decode(bytes);
  }

  async function write(
    path: string,
    data: string | Uint8Array,
    options?: WriteOptions,
  ): Promise<void>;
  async function write(
    files: Record<string, string | Uint8Array>,
    options?: WriteOptions,
  ): Promise<void>;
  async function write(
    input: string | Record<string, string | Uint8Array>,
    data?: string | Uint8Array | WriteOptions,
    maybeOptions?: WriteOptions,
  ): Promise<void> {
    // write(path, data, options) or write({ path: data }, options).
    const single = isString(input);

    const entries: [string, string | Uint8Array][] = single
      ? [[input, isContent(data) ? data : ""]]
      : Object.entries(input);

    const options = (single ? maybeOptions : isContent(data) ? undefined : data) ?? {};

    const { mode } = options;
    // One mkdir per distinct parent within a call; later calls re-check, since commands may remove directories.
    const made = new Set<string>();
    await safe(async () => {
      if (mode !== undefined && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777))
        invalid("mode must be an integer from 0 to 0o7777, such as 0o600");
      const written: string[] = [];

      for (const [path, value] of entries) {
        const dest = pathOf(path),
          parent = posix.dirname(dest);

        if (!fs.writeCreatesParents && !made.has(parent)) {
          await fs.mkdir(id, parent);
          made.add(parent);
        }

        await fs.write(
          id,
          dest,
          isString(value) ? new TextEncoder().encode(value) : value,
          options,
        );
        written.push(dest);
      }

      // Providers without native modes get one chmod for the whole call, after every file exists.
      if (mode === undefined || fs.writeSupportsMode || !written.length) return;

      const result = await provider.exec(id, {
        command: `chmod ${mode.toString(8)} ${written.map(quote).join(" ")}`,
        cwd: "/workspace",
        env: defaults,
        timeoutMs: 30_000,
        onChunk() {},
      });

      if (result.timedOut || result.exitCode !== 0)
        throw new SandboxError(
          `File mode not applied. chmod ${result.timedOut ? "timed out" : `exited with ${result.exitCode}`}; the files were written with default permissions. Check that the paths are writable and retry.`,
          { code: "provider" },
        );
    });
  }

  const gitDir = "/tmp/.sandbox-sdk/changes.git";

  async function git(command: string, stdin?: string): Promise<string> {
    let output = "";

    const result = await provider.exec(id, {
      command: `git --git-dir=${quote(gitDir)} --work-tree=/workspace ${command}`,
      cwd: "/workspace",
      env: { ...defaults, GIT_INDEX_FILE: `${gitDir}/sdk.index` },
      stdin,
      timeoutMs: 120_000,
      onChunk(chunk) {
        if (chunk.stream === "stdout") output += chunk.text;
      },
    });

    if (result.exitCode !== 0)
      throw new SandboxError(
        "File checkpoint failed. Git could not update the hidden index. Ensure git is installed and /workspace is readable.",
        { code: "provider" },
      );

    return output;
  }

  // One exec: init the hidden repo if needed, stage /workspace, write the tree and
  // optionally its mark file. Exit 78 means the guest lacks find; use the RPC path.
  async function tree(mark?: string): Promise<string> {
    // Provider internals under /workspace (e.g. Upstash's .step-git) are pruned like .git.
    const prune = [
      "-name .git",
      ...(fs.internal ?? []).map(
        (name) => `-path ${quote(`./${posix.relative("/workspace", pathOf(name))}`)}`,
      ),
    ].join(" -o ");

    const script = `command -v git >/dev/null 2>&1 || exit 69
command -v find >/dev/null 2>&1 || exit 78
g=${quote(gitDir)}
# A fresh index per call: a killed attempt leaves no index.lock to block later checkpoints.
export GIT_INDEX_FILE="$g/tree.$$.index"; paths="$g/tree.$$.paths"; trap 'rm -f "$GIT_INDEX_FILE" "$GIT_INDEX_FILE.lock" "$paths"' EXIT
[ -d "$g" ] || git init -q --bare "$g" >/dev/null || exit 69
cd /workspace && find . \\( ${prune} \\) -prune -o ! -type d -print0 > "$paths" || exit 1
git --git-dir="$g" --work-tree=/workspace read-tree --empty || exit 1
git --git-dir="$g" --work-tree=/workspace update-index --add --remove -z --stdin < "$paths" || exit 1
tree=$(git --git-dir="$g" --work-tree=/workspace write-tree) || exit 1
${mark ? `mkdir -p ${quote(posix.dirname(mark))} && printf '%s' "$tree" > ${quote(mark)} || exit 1\n` : ""}printf '%s\\n' "$tree"`;

    let output = "";

    const result = await provider.exec(id, {
      command: script,
      cwd: "/workspace",
      env: defaults,
      timeoutMs: 120_000,
      onChunk(chunk) {
        if (chunk.stream === "stdout") output += chunk.text;
      },
    });

    if (result.exitCode === 78) {
      const legacy = await legacyTree();

      if (mark) await write(mark, legacy);

      return legacy;
    }

    if (result.exitCode === 69)
      throw new SandboxError(
        "File checkpoint failed. Git is unavailable. Install git in the sandbox image.",
        { code: "unsupported" },
      );

    if (result.exitCode !== 0)
      throw new SandboxError(
        "File checkpoint failed. Git could not update the hidden index. Ensure git is installed and /workspace is readable.",
        { code: "provider" },
      );

    return output.trim();
  }

  async function legacyTree(): Promise<string> {
    if (!(await filesExist(gitDir))) {
      const result = await provider.exec(id, {
        command: `git init --bare ${quote(gitDir)}`,
        cwd: "/workspace",
        env: defaults,
        timeoutMs: 10_000,
        onChunk() {},
      });

      if (result.exitCode !== 0)
        throw new SandboxError(
          "File checkpoint failed. Git is unavailable. Install git in the sandbox image.",
          { code: "unsupported" },
        );
    }

    // Feed individual files: git add would collapse nested repositories into gitlinks.
    // The one-exec script above does the same with find, pruning every .git entry.
    const paths: string[] = [];
    const internal = new Set((fs.internal ?? []).map((name) => pathOf(name)));

    async function collect(dir: string) {
      for (const entry of await fs.list(id, dir)) {
        if (posix.basename(entry.path) === ".git" || internal.has(entry.path)) continue;

        if (entry.type === "directory") await collect(entry.path);
        else paths.push(posix.relative("/workspace", entry.path));
      }
    }

    await collect("/workspace");
    await git("read-tree --empty");

    if (paths.length) await git("update-index --add --remove -z --stdin", paths.join("\0") + "\0");

    return (await git("write-tree")).trim();
  }

  async function filesExist(path: string) {
    try {
      await fs.stat(id, path);

      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async function snapshot(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    for (const item of await list(".", { recursive: true }))
      if (item.type === "file")
        result[item.path] = Buffer.from(await fs.read(id, item.path)).toString("base64");

    return result;
  }

  const checkpoint = (name: string) => `/tmp/.sandbox-sdk/marks/${encodeURIComponent(name)}.json`;

  async function load(name: string): Promise<Record<string, string>> {
    const raw: unknown = JSON.parse(new TextDecoder().decode(await fs.read(id, checkpoint(name))));

    if (!isObject(raw) || Array.isArray(raw)) invalid("Invalid file checkpoint");
    const parsed: Record<string, string> = {};

    for (const [path, content] of Object.entries(raw)) {
      if (!isString(content)) invalid("Invalid file checkpoint content");
      parsed[path] = content;
    }

    return parsed;
  }

  // createSandbox only records "start" with trackChanges, so explain the opt-in.
  async function missingStart<T>(since: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      // Confirm absence only on failure, so the success path stays one read. If the
      // probe fails too, assume the mark exists and rethrow the original error.
      if (
        (since ?? "start") === "start" &&
        !(await filesExist(checkpoint("start")).catch(() => true))
      )
        throw new SandboxError(
          "No start checkpoint. createSandbox records one only with trackChanges: true. Pass trackChanges: true or call files.mark() and changes({ since }).",
          { code: "invalid_argument" },
        );
      throw error;
    }
  }

  const baseline = (since?: string) =>
    missingStart(since, () => read(checkpoint(since ?? "start")));

  const result: Files & Disposable = {
    [Symbol.dispose]() {
      for (const stop of watchers) stop();
    },
    read,
    write,
    list: (path, options) => safe(() => list(path, options)),
    stat: (path) => safe(() => fs.stat(id, pathOf(path))),
    exists: (path) =>
      safe(async () => {
        try {
          await fs.stat(id, pathOf(path));

          return true;
        } catch (error) {
          if (isNotFound(error)) return false;
          throw error;
        }
      }),
    remove: (path, options) =>
      safe(() => fs.remove(id, pathOf(path), { recursive: options?.recursive ?? false })),
    edit: (path, { find, replace }) =>
      safe(async () => {
        if (!find) invalid("find cannot be empty");

        const dest = pathOf(path);

        if (fs.editInGuest && byteExact(find) && wellFormed(replace) && wellFormed(dest)) {
          const { exitCode, stdout } = await guest(
            editScript,
            { path: dest, find, replace, write: fs.editInGuest },
            true,
          );

          if (exitCode === 0) return;

          if (exitCode === 3)
            throw editFailed(path, stdout.trim() ? stdout.trim().split(" ").map(Number) : []);

          if (exitCode === 71)
            throw new SandboxError(
              `File edit outcome unknown at ${path}. Writing the file failed and its original contents could not be restored. Read the file to check its state before retrying.`,
              { code: "outcome_unknown" },
            );
        }

        const text = await read(path);
        const matches: number[] = [];
        let offset = text.indexOf(find);

        while (offset !== -1) {
          matches.push(text.slice(0, offset).split("\n").length);
          offset = text.indexOf(find, offset + 1);
        }

        if (matches.length !== 1) throw editFailed(path, matches);
        // The file exists, so its parent does too: write without the mkdir.
        await fs.write(id, dest, new TextEncoder().encode(text.replace(find, () => replace)));
      }),
    upload: (source, target, options) =>
      safe(async () => {
        const root = resolve(source);

        if (fs.transfer !== "files" && (await local.lstat(root)).isDirectory()) {
          const temporary = await local.mkdtemp(resolve(tmpdir(), "sandbox-sdk-upload-"));
          const archive = `/tmp/.sandbox-sdk/upload-${crypto.randomUUID()}.tar`;

          try {
            const localArchive = resolve(temporary, "files.tar");
            await hostExec(
              "tar",
              [
                "-cf",
                localArchive,
                "-C",
                root,
                ...(options?.ignore ?? []).flatMap((pattern) => ["--exclude", pattern]),
                ".",
              ],
              { timeout: 120_000 },
            );
            await write(archive, new Uint8Array(await local.readFile(localArchive)));
            await fs.mkdir(id, pathOf(target));
            await remote(`tar -xf ${quote(archive)} -C ${quote(pathOf(target))} --no-same-owner`);
          } finally {
            await local.rm(temporary, { recursive: true, force: true });
            // The transfer's outcome stands; a leftover archive in the sandbox's /tmp is harmless.
            await fs.remove(id, archive, { recursive: false }).catch(() => {});
          }

          return;
        }

        async function visit(src: string, dest: string) {
          const stat = await local.lstat(src);

          if (stat.isSymbolicLink()) invalid("Uploading symlinks is unsupported");

          if (stat.isDirectory()) {
            await fs.mkdir(id, pathOf(dest));

            for (const entry of await local.readdir(src))
              if (
                !options?.ignore?.some(
                  (pattern) =>
                    globMatch(relative(root, resolve(src, entry)), pattern) || pattern === entry,
                )
              )
                await visit(resolve(src, entry), posix.join(dest, entry));
          } else await write(dest, new Uint8Array(await local.readFile(src)));
        }

        await visit(root, target);
      }),
    download: (source, target) =>
      safe(async () => {
        if (fs.transfer !== "files" && (await fs.stat(id, pathOf(source))).type === "directory") {
          const temporary = await local.mkdtemp(resolve(tmpdir(), "sandbox-sdk-download-"));
          const archive = `/tmp/.sandbox-sdk/download-${crypto.randomUUID()}.tar`;

          try {
            // The records directory may not exist yet on a fresh sandbox; make it in the same exec.
            await remote(
              `mkdir -p ${quote(posix.dirname(archive))} && tar -cf ${quote(archive)} -C ${quote(pathOf(source))} .`,
            );
            const localArchive = resolve(temporary, "files.tar");
            await local.writeFile(localArchive, await fs.read(id, archive));
            await local.mkdir(resolve(target), { recursive: true });
            await hostExec(
              "tar",
              [
                "-xf",
                localArchive,
                "-C",
                resolve(target),
                "--no-same-owner",
                "--no-same-permissions",
              ],
              { timeout: 120_000 },
            );
          } finally {
            await local.rm(temporary, { recursive: true, force: true });
            // The transfer's outcome stands; a leftover archive in the sandbox's /tmp is harmless.
            await fs.remove(id, archive, { recursive: false }).catch(() => {});
          }

          return;
        }

        async function visit(src: string, dest: string) {
          const stat = await fs.stat(id, src);

          if (stat.type === "symlink") invalid("Downloading symlinks is unsupported");

          if (stat.type === "directory") {
            await local.mkdir(dest, { recursive: true });

            for (const entry of await fs.list(id, src))
              await visit(entry.path, resolve(dest, posix.basename(entry.path)));
          } else {
            await local.mkdir(resolve(dest, ".."), { recursive: true });
            await local.writeFile(dest, await fs.read(id, src));
          }
        }

        await visit(pathOf(source), resolve(target));
      }),
    search: (query, options = {}) =>
      safe(async () => {
        const result: { path: string; line: number; text: string }[] = [];
        const max = options.maxMatches ?? 200;

        if (!Number.isSafeInteger(max) || max < 1) invalid("maxMatches must be positive");

        const root = pathOf(options.path);

        // An empty query also matches the empty tail after a final newline, and no line holds a newline: keep the RPC walk for both.
        // The guest walks in the adapter's list order, so maxMatches stops at the same files; without one, keep the RPC walk.
        if (
          fs.listOrder &&
          query &&
          !query.includes("\n") &&
          byteExact(query) &&
          wellFormed(root)
        ) {
          const glob = options.glob ?? "";

          const { exitCode, stdout } = await guest(
            searchScript,
            {
              root,
              query,
              pattern: glob && pythonGlob(glob),
              base: glob !== "" && !glob.includes("/"),
              max,
              order: fs.listOrder,
            },
            false,
          );

          if (exitCode === 0) {
            for (const line of stdout.split("\n")) {
              if (!line) continue;
              const row: unknown = JSON.parse(line);

              if (!isSearchRow(row)) {
                result.length = 0;
                break;
              }

              const text = new TextDecoder("utf-8", { ignoreBOM: row[1] !== 1 }).decode(
                Buffer.from(row[2], "base64"),
              );

              if (!text.includes(query)) {
                result.length = 0;
                break;
              }

              result.push({ path: row[0], line: row[1], text: redactor.text(text) });
            }

            if (result.length || !stdout) return result;
          }
        }

        for (const entry of await list(options.path, { recursive: true, glob: options.glob }))
          if (entry.type === "file") {
            const lines = (await read(entry.path)).split("\n");

            for (const [index, text] of lines.entries())
              if (text.includes(query)) {
                result.push({ path: entry.path, line: index + 1, text: redactor.text(text) });

                if (result.length >= max) return result;
              }
          }

        return result;
      }),
    watch(path, callback, options = {}) {
      guard();
      let stopped = false;
      let previous: Map<string, string> | undefined;
      let timer: ReturnType<typeof setTimeout>;
      let wake = () => {};
      const controller = new AbortController();

      const poll = async () => {
        try {
          await ready();

          if (stopped) return;

          const current = new Map(
            (await list(path, options)).map((item) => [
              item.path,
              `${item.size}:${item.modifiedAt}`,
            ]),
          );

          if (previous) {
            for (const [path, value] of current)
              if (!previous.has(path) || previous.get(path) !== value) {
                if (!stopped) callback({ type: previous.has(path) ? "modified" : "added", path });
              }

            for (const path of previous.keys())
              if (!current.has(path) && !stopped) callback({ type: "removed", path });
          }

          previous = current;
        } catch (error) {
          options.onError?.(redactor.error(error, provider.name, id));
        }

        if (!stopped) {
          timer = setTimeout(() => void poll(), options.intervalMs ?? 250);
          timer.unref?.();
        }
      };

      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, ms);
          timer.unref?.();
        });

      // The adapter's own events when it has them. `unsupported` (an old guest, say) switches to polling
      // for good; any other failure is reported and the watch starts again a second later.
      const subscribe = async (native: NonNullable<typeof fs.watch>) => {
        while (!stopped) {
          try {
            await ready();

            if (stopped) return;
            await native.call(fs, id, pathOf(path), {
              recursive: options.recursive ?? false,
              signal: controller.signal,
              onEvent(event) {
                if (!stopped) callback(event);
              },
            });
          } catch (error) {
            if (stopped) return;

            if (error instanceof SandboxError && error.code === "unsupported") {
              void poll();

              return;
            }

            options.onError?.(redactor.error(error, provider.name, id));
          }

          if (!stopped) await pause(1000);
        }
      };

      const stop = () => {
        stopped = true;
        clearTimeout(timer);
        wake();
        controller.abort();
        watchers.delete(stop);
      };

      watchers.add(stop);

      if (fs.watch) void subscribe(fs.watch);
      else void poll();

      return stop;
    },
    mark: (name = `mark-${Date.now()}-${Math.random().toString(36).slice(2)}`) =>
      safe(async () => {
        if (fs.checkpoints === "files")
          await write(checkpoint(name), JSON.stringify(await snapshot()));
        else await tree(checkpoint(name));

        return name;
      }),
    changes: (options = {}) =>
      safe(async () => {
        if (fs.checkpoints !== "files") {
          const before = (await baseline(options.since)).trim(),
            after = await tree();

          if (!/^[0-9a-f]{40,64}$/.test(before)) invalid("Invalid git checkpoint");

          const names = (await git(`diff --no-renames --name-status -z ${before} ${after}`)).split(
            "\0",
          );

          const diff: FileDiff = {
            added: [],
            modified: [],
            removed: [],
            patch: redactor.text(await git(`diff --no-ext-diff --binary ${before} ${after}`)),
          };

          for (let index = 0; index + 1 < names.length; index += 2) {
            const status = names[index],
              path = names[index + 1];

            if (path)
              (status === "A" ? diff.added : status === "D" ? diff.removed : diff.modified).push(
                pathOf(path),
              );
          }

          return diff;
        }

        const before = await missingStart(options.since, () => load(options.since ?? "start")),
          after = await snapshot();

        const added = Object.keys(after).filter((path) => !(path in before));
        const removed = Object.keys(before).filter((path) => !(path in after));

        const modified = Object.keys(after).filter(
          (path) => path in before && before[path] !== after[path],
        );

        const patch = [...added, ...modified, ...removed]
          .map((path) =>
            wholeFilePatch(
              posix.relative("/workspace", path),
              path in before ? Buffer.from(before[path] ?? "", "base64").toString() : undefined,
              path in after ? Buffer.from(after[path] ?? "", "base64").toString() : undefined,
            ),
          )
          .join("");

        return { added, modified, removed, patch: redactor.text(patch) };
      }),
  };

  boundedReads.set(result, (path, maxBytes) =>
    safe(() =>
      fs.readRange
        ? fs.readRange(id, pathOf(path), { offset: 0, length: maxBytes + 1 })
        : fs.read(id, pathOf(path)),
    ),
  );

  return result;
}

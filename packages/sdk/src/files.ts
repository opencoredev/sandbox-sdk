import { posix, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as local } from "node:fs";
import type { Provider, FileInfo } from "./provider.js";
import { SandboxError, invalid, type Redactor } from "./errors.js";
import { pathOf, quote, defaults } from "./run.js";
export interface FileEvent { type: "added" | "modified" | "removed"; path: string }
export interface FileDiff { added: string[]; modified: string[]; removed: string[]; patch: string }
export interface Files {
  read(path: string): Promise<string>;
  read(path: string, options: { as: "bytes" }): Promise<Uint8Array>;
  write(path: string, data: string | Uint8Array): Promise<void>;
  write(files: Record<string, string | Uint8Array>): Promise<void>;
  edit(path: string, edit: { find: string; replace: string }): Promise<void>;
  list(path?: string, options?: { recursive?: boolean; glob?: string }): Promise<FileInfo[]>;
  stat(path: string): Promise<FileInfo>;
  exists(path: string): Promise<boolean>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  upload(source: string, target: string, options?: { ignore?: string[] }): Promise<void>;
  download(source: string, target: string): Promise<void>;
  search(query: string, options?: { path?: string; glob?: string; maxMatches?: number }): Promise<{ path: string; line: number; text: string }[]>;
  watch(path: string, callback: (event: FileEvent) => void, options?: { recursive?: boolean; intervalMs?: number; onError?: (error: SandboxError) => void }): () => void;
  mark(name?: string): Promise<string>;
  changes(options?: { since?: string }): Promise<FileDiff>;
}
export function globMatch(path: string, glob: string) {
  const pattern = glob.split(/(\*\*\/|\*\*|\*|\?)/).map(part => part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "." : part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join("");
  return new RegExp(`^${pattern}$`).test(path) || (!glob.includes("/") && new RegExp(`^${pattern}$`).test(posix.basename(path)));
}
// One guest command records the "start" checkpoint and the secret-names file. The equivalent
// mark("start") plus write() costs about eight sequential provider calls. Returns false when the
// guest cannot run it (no git or find), so the caller falls back to the per-call path.
export async function initializeFiles({ provider, id, secretNames }: { provider: Provider; id: string; secretNames: string }): Promise<boolean> {
  if (provider.name === "memory") return false;
  const sdk = "/tmp/.sandbox-sdk", gitDir = `${sdk}/changes.git`;
  const script = [
    "set -e",
    `mkdir -p ${sdk}/marks`,
    `[ -d ${gitDir} ] || git init -q --bare ${gitDir}`,
    `export GIT_DIR=${gitDir} GIT_WORK_TREE=/workspace GIT_INDEX_FILE=${gitDir}/sdk.index`,
    "git read-tree --empty",
    // Same file set as tree(): skip .git entries so nested repositories stay plain files.
    `find . -mindepth 1 \\( -name .git${(provider.files.internal ?? []).map(name => ` -o -path ${quote(`./${name}`)}`).join("")} \\) -prune -o ! -type d -print0 | git update-index --add --remove -z --stdin`,
    "tree=$(git write-tree)",
    `printf %s "$tree" > ${sdk}/marks/${encodeURIComponent("start")}.json`,
    `printf %s ${quote(secretNames)} > ${sdk}/secret-names.json`,
  ].join("\n");
  const result = await provider.exec(id, { command: script, cwd: "/workspace", env: defaults, timeoutMs: 30_000, streaming: false, onChunk() {} });
  return result.exitCode === 0;
}
export function makeFiles(provider: Provider, id: string, redactor: Redactor, guard: () => void = () => {}): Files & Disposable {
  const fs = provider.files; const watchers = new Set<() => void>();
  const hostExec = promisify(execFile);
  async function remote(command: string) {
    const result = await provider.exec(id, { command, cwd: "/workspace", env: defaults, timeoutMs: 120_000, onChunk() {} });
    if (result.exitCode !== 0) throw new SandboxError("File transfer failed. The remote archive command failed. Ensure tar is installed and paths are accessible.", { code: "provider" });
  }
  const safe = async <T>(action: () => Promise<T>): Promise<T> => { try { guard(); return await action(); } catch (error) { throw redactor.error(error, provider.name, id); } };
  async function list(path = ".", options: { recursive?: boolean; glob?: string } = {}): Promise<FileInfo[]> {
    const root = pathOf(path); const result: FileInfo[] = [];
    async function visit(dir: string) {
      for (const entry of await fs.list(id, dir)) {
        if (!options.glob || globMatch(posix.relative(root, entry.path), options.glob)) result.push(entry);
        if (options.recursive && entry.type === "directory") await visit(entry.path);
      }
    }
    await visit(root); return result;
  }
  async function read(path: string): Promise<string>;
  async function read(path: string, options: { as: "bytes" }): Promise<Uint8Array>;
  async function read(path: string, options?: { as: "bytes" }): Promise<string | Uint8Array> {
    const bytes = await safe(() => fs.read(id, pathOf(path)));
    // File reads are data, not output logs. Preserve exact contents (including binary).
    return options?.as === "bytes" ? bytes : new TextDecoder().decode(bytes);
  }
  async function write(path: string, data: string | Uint8Array): Promise<void>;
  async function write(files: Record<string, string | Uint8Array>): Promise<void>;
  async function write(input: string | Record<string, string | Uint8Array>, data?: string | Uint8Array): Promise<void> {
    const entries = typeof input === "string" ? [[input, data ?? ""] satisfies [string, string | Uint8Array]] : Object.entries(input);
    await safe(async () => { for (const [path, value] of entries) { const dest = pathOf(path); if (!fs.writeCreatesParents) await fs.mkdir(id, posix.dirname(dest)); await fs.write(id, dest, typeof value === "string" ? new TextEncoder().encode(value) : value); } });
  }
  const gitDir = "/tmp/.sandbox-sdk/changes.git";
  async function git(command: string, stdin?: string): Promise<string> {
    let output = "";
    const result = await provider.exec(id, { command: `git --git-dir=${quote(gitDir)} --work-tree=/workspace ${command}`, cwd: "/workspace", env: { ...defaults, GIT_INDEX_FILE: `${gitDir}/sdk.index` }, stdin, timeoutMs: 120_000, onChunk(chunk) { if (chunk.stream === "stdout") output += chunk.text; } });
    if (result.exitCode !== 0) throw new SandboxError("File checkpoint failed. Git could not update the hidden index. Ensure git is installed and /workspace is readable.", { code: "provider" });
    return output;
  }
  async function tree(): Promise<string> {
    if (!(await filesExist(gitDir))) {
      const result = await provider.exec(id, { command: `git init --bare ${quote(gitDir)}`, cwd: "/workspace", env: defaults, timeoutMs: 10_000, onChunk() {} });
      if (result.exitCode !== 0) throw new SandboxError("File checkpoint failed. Git is unavailable. Install git in the sandbox image.", { code: "unsupported" });
    }
    // Feed individual files: git add would collapse nested repositories into gitlinks.
    const paths: string[] = [];
    const internal = new Set((fs.internal ?? []).map(name => pathOf(name)));
    async function collect(dir: string) { for (const entry of await fs.list(id, dir)) { if (posix.basename(entry.path) === ".git" || internal.has(entry.path)) continue; if (entry.type === "directory") await collect(entry.path); else paths.push(posix.relative("/workspace", entry.path)); } }
    await collect("/workspace"); await git("read-tree --empty");
    if (paths.length) await git("update-index --add --remove -z --stdin", paths.join("\0") + "\0");
    return (await git("write-tree")).trim();
  }
  async function filesExist(path: string) { try { await fs.stat(id, path); return true; } catch (error) { if (error instanceof SandboxError && ["file_not_found", "not_found"].includes(error.code)) return false; throw error; } }
  async function snapshot(): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const item of await list(".", { recursive: true })) if (item.type === "file") result[item.path] = Buffer.from(await fs.read(id, item.path)).toString("base64");
    return result;
  }
  const checkpoint = (name: string) => `/tmp/.sandbox-sdk/marks/${encodeURIComponent(name)}.json`;
  async function load(name: string): Promise<Record<string, string>> {
    const raw: unknown = JSON.parse(new TextDecoder().decode(await fs.read(id, checkpoint(name))));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("Invalid file checkpoint");
    const parsed: Record<string, string> = {};
    for (const [path, content] of Object.entries(raw)) { if (typeof content !== "string") invalid("Invalid file checkpoint content"); parsed[path] = content; }
    return parsed;
  }
  return {
    [Symbol.dispose]() { for (const stop of watchers) stop(); },
    read, write,
    list: (path, options) => safe(() => list(path, options)),
    stat: path => safe(() => fs.stat(id, pathOf(path))),
    exists: path => safe(async () => { try { await fs.stat(id, pathOf(path)); return true; } catch (error) { if (error instanceof SandboxError && ["file_not_found", "not_found"].includes(error.code)) return false; throw error; } }),
    remove: (path, options) => safe(() => fs.remove(id, pathOf(path), { recursive: options?.recursive ?? false })),
    edit: (path, { find, replace }) => safe(async () => {
      if (!find) invalid("find cannot be empty"); const text = await read(path); const matches: number[] = [];
      let offset = text.indexOf(find);
      while (offset !== -1) { matches.push(text.slice(0, offset).split("\n").length); offset = text.indexOf(find, offset + 1); }
      if (matches.length !== 1) throw new SandboxError(`Edit failed at ${path}. ${matches.length ? `Matches on lines ${matches.join(", ")}` : "Text not found"}. Supply a unique exact match.`, { code: matches.length ? "edit_not_unique" : "edit_not_found" });
      await write(path, text.replace(find, () => replace));
    }),
    upload: (source, target, options) => safe(async () => {
      const root = resolve(source);
      if (provider.name !== "memory" && fs.transfer !== "files" && (await local.lstat(root)).isDirectory()) {
        const temporary = await local.mkdtemp(resolve(tmpdir(), "sandbox-sdk-upload-"));
        const archive = `/tmp/.sandbox-sdk/upload-${crypto.randomUUID()}.tar`;
        try {
          const localArchive = resolve(temporary, "files.tar");
          await hostExec("tar", ["-cf", localArchive, "-C", root, ...(options?.ignore ?? []).flatMap(pattern => ["--exclude", pattern]), "."], { timeout: 120_000 });
          await write(archive, new Uint8Array(await local.readFile(localArchive)));
          await fs.mkdir(id, pathOf(target)); await remote(`tar -xf ${quote(archive)} -C ${quote(pathOf(target))} --no-same-owner`);
        } finally { await local.rm(temporary, { recursive: true, force: true }); await fs.remove(id, archive, { recursive: false }).catch(() => {}); }
        return;
      }
      async function visit(src: string, dest: string) {
        const stat = await local.lstat(src);
        if (stat.isSymbolicLink()) invalid("Uploading symlinks is unsupported");
        if (stat.isDirectory()) {
          await fs.mkdir(id, pathOf(dest));
          for (const entry of await local.readdir(src)) if (!options?.ignore?.some(pattern => globMatch(relative(root, resolve(src, entry)), pattern) || pattern === entry)) await visit(resolve(src, entry), posix.join(dest, entry));
        } else await write(dest, new Uint8Array(await local.readFile(src)));
      }
      await visit(root, target);
    }),
    download: (source, target) => safe(async () => {
      if (provider.name !== "memory" && fs.transfer !== "files" && (await fs.stat(id, pathOf(source))).type === "directory") {
        const temporary = await local.mkdtemp(resolve(tmpdir(), "sandbox-sdk-download-"));
        const archive = `/tmp/.sandbox-sdk/download-${crypto.randomUUID()}.tar`;
        try {
          await remote(`tar -cf ${quote(archive)} -C ${quote(pathOf(source))} .`);
          const localArchive = resolve(temporary, "files.tar"); await local.writeFile(localArchive, await fs.read(id, archive));
          await local.mkdir(resolve(target), { recursive: true });
          await hostExec("tar", ["-xf", localArchive, "-C", resolve(target), "--no-same-owner", "--no-same-permissions"], { timeout: 120_000 });
        } finally { await local.rm(temporary, { recursive: true, force: true }); await fs.remove(id, archive, { recursive: false }).catch(() => {}); }
        return;
      }
      async function visit(src: string, dest: string) {
        const stat = await fs.stat(id, src);
        if (stat.type === "symlink") invalid("Downloading symlinks is unsupported");
        if (stat.type === "directory") { await local.mkdir(dest, { recursive: true }); for (const entry of await fs.list(id, src)) await visit(entry.path, resolve(dest, posix.basename(entry.path))); }
        else { await local.mkdir(resolve(dest, ".."), { recursive: true }); await local.writeFile(dest, await fs.read(id, src)); }
      }
      await visit(pathOf(source), resolve(target));
    }),
    search: (query, options = {}) => safe(async () => {
      const result: { path: string; line: number; text: string }[] = []; const max = options.maxMatches ?? 200;
      if (!Number.isSafeInteger(max) || max < 1) invalid("maxMatches must be positive");
      for (const entry of await list(options.path, { recursive: true, glob: options.glob })) if (entry.type === "file") {
        const lines = (await read(entry.path)).split("\n");
        for (const [index, text] of lines.entries()) if (text.includes(query)) { result.push({ path: entry.path, line: index + 1, text: redactor.text(text) }); if (result.length >= max) return result; }
      }
      return result;
    }),
    watch(path, callback, options = {}) {
      guard();
      let stopped = false; let previous: Map<string, string> | undefined; let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const current = new Map((await list(path, options)).map(item => [item.path, `${item.size}:${item.modifiedAt}`]));
          if (previous) {
            for (const [path, value] of current) if (!previous.has(path) || previous.get(path) !== value) { if (!stopped) callback({ type: previous.has(path) ? "modified" : "added", path }); }
            for (const path of previous.keys()) if (!current.has(path) && !stopped) callback({ type: "removed", path });
          }
          previous = current;
        } catch (error) { options.onError?.(redactor.error(error, provider.name, id)); }
        if (!stopped) { timer = setTimeout(() => void poll(), options.intervalMs ?? 250); timer.unref?.(); }
      };
      const stop = () => { stopped = true; clearTimeout(timer); watchers.delete(stop); };
      watchers.add(stop); void poll(); return stop;
    },
    mark: (name = `mark-${Date.now()}-${Math.random().toString(36).slice(2)}`) => safe(async () => { await write(checkpoint(name), provider.name === "memory" ? JSON.stringify(await snapshot()) : await tree()); return name; }),
    changes: (options = {}) => safe(async () => {
      if (provider.name !== "memory") {
        const before = (await read(checkpoint(options.since ?? "start"))).trim(), after = await tree();
        if (!/^[0-9a-f]{40,64}$/.test(before)) invalid("Invalid git checkpoint");
        const names = (await git(`diff --no-renames --name-status -z ${before} ${after}`)).split("\0");
        const diff: FileDiff = { added: [], modified: [], removed: [], patch: redactor.text(await git(`diff --no-ext-diff --binary ${before} ${after}`)) };
        for (let index = 0; index + 1 < names.length; index += 2) { const status = names[index], path = names[index + 1]; if (path) (status === "A" ? diff.added : status === "D" ? diff.removed : diff.modified).push(pathOf(path)); }
        return diff;
      }
      const before = await load(options.since ?? "start"), after = await snapshot();
      const added = Object.keys(after).filter(path => !(path in before));
      const removed = Object.keys(before).filter(path => !(path in after));
      const modified = Object.keys(after).filter(path => path in before && before[path] !== after[path]);
      const patch = [...added, ...modified, ...removed].map(path => {
        const beforeText = Buffer.from(before[path] ?? "", "base64").toString(), afterText = Buffer.from(after[path] ?? "", "base64").toString();
        const oldLines = beforeText ? beforeText.replace(/\n$/, "").split("\n") : [];
        const newLines = afterText ? afterText.replace(/\n$/, "").split("\n") : [];
        return `--- ${path in before ? "a/" + posix.relative("/workspace", path) : "/dev/null"}\n+++ ${path in after ? "b/" + posix.relative("/workspace", path) : "/dev/null"}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${oldLines.map(line => "-" + line + "\n").join("")}${oldLines.length && !beforeText.endsWith("\n") ? "\\ No newline at end of file\n" : ""}${newLines.map(line => "+" + line + "\n").join("")}${newLines.length && !afterText.endsWith("\n") ? "\\ No newline at end of file\n" : ""}`;
      }).join("");
      return { added, modified, removed, patch: redactor.text(patch) };
    }),
  };
}

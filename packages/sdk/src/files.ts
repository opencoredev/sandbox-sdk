import { posix, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as local } from "node:fs";
import type { Provider, FileInfo, WriteOptions } from "./provider.js";
import { SandboxError, invalid, isNotFound, type Redactor } from "./errors.js";
import { pathOf, defaults } from "./run.js";
import { quote } from "./shared/shell.js";
import { isObject, isString } from "./shared/narrow.js";

export interface FileEvent {
  type: "added" | "modified" | "removed";
  path: string;
}

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

export function globMatch(path: string, glob: string) {
  const pattern = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
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

  return {
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
        const text = await read(path);
        const matches: number[] = [];
        let offset = text.indexOf(find);

        while (offset !== -1) {
          matches.push(text.slice(0, offset).split("\n").length);
          offset = text.indexOf(find, offset + 1);
        }

        if (matches.length !== 1)
          throw new SandboxError(
            `Edit failed at ${path}. ${matches.length ? `Matches on lines ${matches.join(", ")}` : "Text not found"}. Supply a unique exact match.`,
            { code: matches.length ? "edit_not_unique" : "edit_not_found" },
          );
        await write(
          path,
          text.replace(find, () => replace),
        );
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

      const stop = () => {
        stopped = true;
        clearTimeout(timer);
        watchers.delete(stop);
      };

      watchers.add(stop);
      void poll();

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
}

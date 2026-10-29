import type { RunHandle, RunOptions, RunResult } from "./types.js";
import { removeIfPresent, type Files } from "./files.js";
import type { Redactor } from "./errors.js";
import { quote } from "./shared/shell.js";

export interface Git {
  clone(
    url: string,
    options?: { dir?: string; branch?: string; depth?: number; token?: string },
  ): Promise<RunResult>;
  status(dir?: string): Promise<RunResult>;
  diff(dir?: string): Promise<RunResult>;
  commit(
    dir: string,
    options: { message: string; all?: boolean; author?: string },
  ): Promise<RunResult>;
  push(
    dir: string,
    options?: { token?: string; remote?: string; branch?: string },
  ): Promise<RunResult>;
  checkout(dir: string, options: { branch: string; create?: boolean }): Promise<RunResult>;
}

export function makeGit(
  run: (command: string, options?: RunOptions) => RunHandle,
  files: Files,
  redactor: Redactor,
): Git {
  async function auth(command: string, token: string | undefined, cwd?: string) {
    if (!token) return await run(`git ${command}`, { cwd });
    redactor.add([token]);
    const helper = `/tmp/.sandbox-sdk/credential-${crypto.randomUUID()}`;
    // Token travels only in stdin; the helper reads its sibling file. Never argv/env/history.
    const script = `#!/bin/sh\nif [ "$1" = get ]; then printf 'username=x-access-token\\npassword='; cat ${quote(helper + ".token")}; printf '\\n'; fi\n`;
    await run(
      `umask 077; mkdir -p /tmp/.sandbox-sdk; cat > ${quote(helper + ".token")}; printf '%s' ${quote(script)} > ${quote(helper)}`,
      { stdin: token },
    );

    const removeCredentials = () =>
      Promise.all([removeIfPresent(files, helper), removeIfPresent(files, helper + ".token")]);

    let result: RunResult;

    try {
      result = await run(
        `git -c credential.helper= -c ${quote(`credential.helper=!sh ${quote(helper)}`)} ${command}`,
        { cwd },
      );
    } catch (error) {
      // The command's own failure is the one to report.
      await removeCredentials().catch(() => {});
      throw error;
    }

    // A token left on disk must not pass silently.
    await removeCredentials();

    return result;
  }

  return {
    clone: (url, options = {}) =>
      auth(
        `clone ${options.branch ? `--branch ${quote(options.branch)} ` : ""}${options.depth ? `--depth ${quote(String(options.depth))} ` : ""}-- ${quote(url)} ${quote(options.dir ?? "app")}`,
        options.token,
      ),
    status: (dir) => Promise.resolve(run("git status --porcelain", { cwd: dir })),
    diff: (dir) => Promise.resolve(run("git diff", { cwd: dir })),
    commit: async (dir, options) => {
      if (options.all) await run("git add -A", { cwd: dir });

      return await run(
        `git commit -m ${quote(options.message)}${options.author ? ` --author=${quote(options.author)}` : ""}`,
        { cwd: dir },
      );
    },
    push: (dir, options = {}) =>
      auth(
        `push -- ${quote(options.remote ?? "origin")}${options.branch ? ` ${quote(options.branch)}` : ""}`,
        options.token,
        dir,
      ),
    checkout: (dir, options) =>
      Promise.resolve(
        run(`git checkout ${options.create ? "-b " : ""}${quote(options.branch)}`, { cwd: dir }),
      ),
  };
}

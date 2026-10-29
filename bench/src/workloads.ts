import { readFile, readdir } from "node:fs/promises";
import type { Sandbox } from "@opencoredev/sandbox-sdk";

export class Skip extends Error {}

export const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export async function command(box: Sandbox, cmd: string, timeoutMs: number, signal?: AbortSignal) {
  const r = await box.run(cmd, { timeoutMs, signal });

  if (!r.ok)
    throw new Error(`Guest exit ${r.exitCode}: ${r.stderr.slice(-1200) || r.stdout.slice(-1200)}`);

  return r.stdout.trim();
}

export async function uploadFixture(box: Sandbox) {
  for (const file of await readdir(new URL("../fixtures/vite-react/", import.meta.url)))
    if (file !== "node_modules")
      await box.files.write(
        `/workspace/bench-app/${file}`,
        await readFile(new URL(`../fixtures/vite-react/${file}`, import.meta.url)),
      );
}

export const cloneCommand =
  'rm -rf /workspace/bench-clone && git clone --depth 1 --no-checkout https://github.com/octocat/Hello-World.git /workspace/bench-clone && cd /workspace/bench-clone && git fetch --depth 1 origin 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';

export async function previewText(box: Sandbox, signal: AbortSignal) {
  const p = await box.preview(3000);
  const u = new URL(p.url);

  if (!["http:", "https:"].includes(u.protocol) || u.hostname.endsWith(".invalid"))
    throw new Skip("No usable preview URL");
  const r = await fetch(u, { headers: { ...p.headers, "Cache-Control": "no-cache" }, signal });

  if (!r.ok) throw new Error(`Preview HTTP ${r.status}`);

  return r.text();
}

export async function replay(box: Sandbox, timeoutMs: number) {
  const timings: { op: string; ms: number }[] = [];
  const path = "/workspace/bench-replay.txt";

  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    let op = "";

    switch (i % 6) {
      case 0:
        op = "write";
        await box.files.write(path, "hello world\n");
        break;
      case 1:
        op = "read";

        if (!(await box.files.read(path)).includes("hello"))
          throw new Error("Replay read mismatch");
        break;
      case 2:
        op = "edit";
        await box.files.edit(path, { find: "world", replace: "benchmark" });
        break;
      case 3:
        op = "ls";
        await box.files.list("/workspace");
        break;
      case 4:
        op = "grep";
        await command(box, `grep hello ${path}`, timeoutMs);
        break;
      case 5:
        op = "test";
        await command(box, "cd /workspace/bench-app && node --test test.mjs", timeoutMs);
        break;
    }

    timings.push({ op, ms: performance.now() - start });
  }

  return timings;
}

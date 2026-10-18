import { describe, test, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox, connectSandbox, listSandboxes, reapSandboxes, SandboxError } from "./index.js";
import type { Provider } from "./provider.js";
import type { SandboxBase } from "./types.js";
/** Register a provider-independent Vitest suite. Call inside a test module.
 * live must be explicitly true to run a cloud provider. memory skips real git
 * and HTTP probes, since it never executes host programs or opens sockets.
 */
export function runConformance(factory: () => Provider | Promise<Provider>, options: { live: boolean }) {
  describe("Sandbox SDK conformance", () => {
    const cleanup: SandboxBase<unknown>[] = [];
    const temp: string[] = [];
    async function setup() {
      const provider = await factory();
      if (!options.live && !["memory", "local"].includes(provider.name)) throw new SandboxError("Live provider refused. live is false. Enable live explicitly with provider credentials.", { code: "invalid_argument" });
      const box = await createSandbox(provider); cleanup.push(box); return { provider, box };
    }
    afterEach(async () => { await Promise.all(cleanup.splice(0).map(box => box.destroy())); await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
    test("create, key lookup, connect and labels", async () => {
      const provider = await factory();
      if (!options.live && !["memory", "local"].includes(provider.name)) throw new Error("live must be enabled");
      const key = `conformance-${crypto.randomUUID()}`;
      const first = await createSandbox(provider, { key, labels: { suite: key } }); cleanup.push(first);
      const second = await createSandbox(provider, { key }); cleanup.push(second);
      expect(first.created).toBe(true); expect(second.created).toBe(false); expect(second.id).toBe(first.id);
      const reattached = await connectSandbox(provider, first.id); cleanup.push(reattached);
      expect(reattached.native).toBeDefined(); expect((await listSandboxes(provider, { labels: { suite: key } })).map(box => box.id)).toEqual([first.id]);
    });
    test("exit results, stdin, resolved cwd and default environment", async () => {
      const { box } = await setup();
      expect(await box.run("false")).toMatchObject({ ok: false, exitCode: 1, timedOut: false });
      expect(await box.run("exit 7")).toMatchObject({ exitCode: 7 });
      expect((await box.run("cat", { stdin: "input\n" })).stdout).toBe("input\n");
      expect((await box.run("pwd")).stdout).toBe("/workspace\n");
      expect((await box.run("printf '%s' \"$CI:$PAGER:$GIT_TERMINAL_PROMPT:$DEBIAN_FRONTEND:$TERM:$NO_COLOR\"")).stdout).toBe("1:cat:0:noninteractive:dumb:1");
    });
    test("timeout and abort kill work before following side effects", async () => {
      const { box } = await setup();
      const result = await box.run("sleep 1; echo survived > survived", { timeoutMs: 20 });
      expect(result).toMatchObject({ timedOut: true, exitCode: null, ok: false });
      const controller = new AbortController(); const handle = box.run("sleep 1; echo survived > aborted", { signal: controller.signal });
      const pending = Promise.resolve(handle); setTimeout(() => controller.abort(), 20);
      expect(await pending).toMatchObject({ timedOut: true, exitCode: null });
      expect(await box.files.exists("survived")).toBe(false); expect(await box.files.exists("aborted")).toBe(false);
    });
    test("bounded head and tail output, interleaving and streaming", async () => {
      const { box } = await setup();
      const result = await box.run(`printf '${"a".repeat(1024)}END'`, { maxOutputBytes: 64 });
      expect(result.truncated).toBe(true); expect(result.stdout.startsWith("a")).toBe(true); expect(result.stdout.endsWith("END")).toBe(true); expect(result.stdout).toContain("bytes cut");
      // Separate OS pipes can coalesce writes; compare with actual arrival order.
      const mixed = box.run("printf A; printf B >&2; printf C"); const arrival: string[] = [];
      for await (const chunk of mixed) arrival.push(chunk.text);
      const resultMixed = await mixed;
      expect(resultMixed).toMatchObject({ stdout: "AC", stderr: "B", output: arrival.join("") });
      const chunks = []; for await (const chunk of box.run("echo streamed")) chunks.push(chunk.text);
      expect(chunks.join("")).toBe("streamed\n");
    });
    test("tag escaping and chain options prevent interpolation execution", async () => {
      const { box } = await setup(); const input = "x'; echo injected; printf '";
      expect((await box.$`printf '%s' ${input}`.cwd(".").env({ X: "ok" }).timeout(1000)).stdout).toBe(input);
      expect((await box.run("printf '%s' \"$X\"")).stdout).toBe("");
    });
    test("all file primitives, exact edits, glob search, checkpoints", async () => {
      const { box } = await setup(); await box.files.write({ "app/a.ts": "TODO one\nsecond", "app/b.ts": "two two", "app/raw": new Uint8Array([0, 255]) });
      expect(await box.files.read("app/raw", { as: "bytes" })).toEqual(new Uint8Array([0, 255]));
      expect((await box.files.stat("app/a.ts")).type).toBe("file");
      expect((await box.files.list("app", { recursive: true, glob: "**/*.ts" })).length).toBe(2);
      expect(await box.files.search("TODO", { path: "app", glob: "*.ts" })).toMatchObject([{ line: 1, text: "TODO one" }]);
      await expect(box.files.edit("app/a.ts", { find: "missing", replace: "x" })).rejects.toMatchObject({ code: "edit_not_found" });
      await expect(box.files.edit("app/b.ts", { find: "two", replace: "x" })).rejects.toMatchObject({ code: "edit_not_unique" });
      const mark = await box.files.mark(); await box.files.edit("app/a.ts", { find: "TODO", replace: "DONE" }); await box.files.remove("app/b.ts"); await box.files.write("app/new", "new");
      expect(await box.files.changes({ since: mark })).toMatchObject({ added: ["/workspace/app/new"], modified: ["/workspace/app/a.ts"], removed: ["/workspace/app/b.ts"] });
      expect((await box.files.changes()).added).toContain("/workspace/app/a.ts");
      await box.files.remove("app", { recursive: true }); expect(await box.files.exists("app")).toBe(false);
    });
    test("upload/download round trip with ignores", async () => {
      const { box } = await setup(); const path = await mkdtemp(join(tmpdir(), "sdk-conformance-")); temp.push(path);
      await mkdir(join(path, "source")); await writeFile(join(path, "source", "keep"), "hello"); await writeFile(join(path, "source", "ignore"), "no");
      await box.files.upload(join(path, "source"), "upload", { ignore: ["ignore"] });
      expect(await box.files.exists("upload/ignore")).toBe(false);
      await box.files.download("upload", join(path, "download")); expect(await readFile(join(path, "download", "keep"), "utf8")).toBe("hello");
    });
    test("file watch observes changes", async () => {
      const { box } = await setup(); await box.files.write("watch/file", "a");
      const events: string[] = []; const stop = box.files.watch("watch", event => events.push(event.type), { recursive: true, intervalMs: 10 });
      try { await new Promise(resolve => setTimeout(resolve, 30)); await box.files.write("watch/file", "different"); await new Promise(resolve => setTimeout(resolve, 50)); expect(events).toContain("modified"); } finally { stop(); }
    });
    test("process logs, cursors, fresh client reattach, stop and exit-before-ready", async () => {
      const { provider, box } = await setup();
      const process = await box.start("echo READY; sleep 5", { name: "dev", ready: { log: /READY/ }, readyTimeoutMs: 2000 });
      expect(process.ready).toBe(true); const page = await process.logs(); expect(page.text).toContain("READY");
      expect((await process.logs({ after: page.nextCursor })).text).toBe("");
      const client = await connectSandbox(provider, box.id); cleanup.push(client);
      expect((await client.processes()).map(process => process.name)).toContain("dev");
      expect((await client.process("dev").logs()).text).toContain("READY");
      await client.process("dev").stop({ graceMs: 10 }); expect((await process.wait()).exitCode).not.toBe(null);
      await expect(box.start("exit 3", { name: "early", ready: { log: /never/ }, readyTimeoutMs: 1000 })).rejects.toMatchObject({ code: "process_exited" });
    });
    test("readiness timeout preserves the process", async () => {
      const { box } = await setup();
      await expect(box.start("sleep 5", { name: "unready", ready: { log: /never/ }, readyTimeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
      expect(box.process("unready").ready).toBe(false); expect((await box.processes())[0]?.status).toBe("running"); await box.process("unready").stop({ graceMs: 10 });
    });
    test("preview and capability gating", async () => {
      const { provider, box } = await setup(); expect((await box.preview(3000)).url).toContain("3000");
      for (const [capability, method] of [["pause", "pause"], ["snapshot", "snapshot"], ["terminal", "terminal"]] as const) expect(method in box).toBe(provider.capabilities.has(capability));
      if (!provider.capabilities.has("network-policy")) await expect(createSandbox(provider, { network: "none" })).rejects.toMatchObject({ code: "unsupported" });
      if (!provider.capabilities.has("size")) await expect(createSandbox(provider, { size: "small" })).rejects.toMatchObject({ code: "unsupported" });
    });
    test("close, disposal, destroy and label-scoped reaping", async () => {
      const { provider, box } = await setup(); const id = box.id; await box.close(); expect((await connectSandbox(provider, id)).id).toBe(id);
      await box.destroy(); await expect(connectSandbox(provider, id)).rejects.toMatchObject({ code: "not_found" });
      const key = crypto.randomUUID(); const keyed = await createSandbox(provider, { key, labels: { reap: key } }); cleanup.push(keyed); await keyed[Symbol.asyncDispose]();
      expect((await provider.connect(keyed.id)).id).toBe(keyed.id);
      expect(await reapSandboxes(provider, { labels: { reap: key }, olderThanMs: 0 })).toBe(1);
      const ephemeral = await createSandbox(provider); await ephemeral[Symbol.asyncDispose](); await expect(provider.connect(ephemeral.id)).rejects.toMatchObject({ code: "not_found" });
    });
    test("usage counters", async () => { const { box } = await setup(); await box.run("echo abc"); expect(await box.usage()).toMatchObject({ commands: 1, bytesOut: 4 }); });
    test("local bare git clone and commit (live Linux providers only)", async context => {
      const { provider, box } = await setup(); if (provider.name === "memory") { context.skip(); return; }
      expect((await box.run("git init --bare /tmp/sdk-bare")).ok).toBe(true);
      expect((await box.git.clone("/tmp/sdk-bare", { dir: "repo" })).ok).toBe(true);
      await box.run("git config user.name Conformance; git config user.email test@example.com", { cwd: "repo" });
      await box.files.write("repo/test", "test"); expect((await box.git.commit("repo", { message: "conformance", all: true })).ok).toBe(true);
      expect((await box.git.status("repo")).stdout).toBe(""); expect((await box.git.push("repo", { branch: "HEAD" })).ok).toBe(true);
    });
    test("real HTTP preview probe (live Linux providers only)", async context => {
      const { provider, box } = await setup(); if (provider.name === "memory") { context.skip(); return; }
      const proc = await box.start("node -e 'require(\"http\").createServer((_,r)=>r.end(\"ok\")).listen(3000,\"0.0.0.0\")'", { name: "http", ready: { http: { port: 3000 } } });
      expect(proc.ready).toBe(true); expect((await box.preview(3000, { waitMs: 2000 })).url).toBeTruthy(); await proc.stop();
    });
  });
}

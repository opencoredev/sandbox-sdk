import { describe, test, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSandbox,
  connectSandbox,
  hasCapability,
  listSandboxes,
  reapSandboxes,
  SandboxError,
} from "./index.js";
import type { Provider, SnapshotOptions } from "./provider.js";
import type { RunOptions, SandboxBase } from "./types.js";

/** Register a provider-independent Vitest suite. Call inside a test module.
 * live must be explicitly true to run a cloud provider. Each case calls the factory
 * for a fresh provider, and the reattach check connects through a second one, so a
 * factory for in-process state must return a shared instance.
 * Live runs give each case 120 seconds by default, since real providers boot
 * machines and cross the network; pass timeoutMs to change it.
 * snapshotExpiry declares what `snapshot({ expiresInMs })` does: "honored" must
 * return a snapshot, "refused" must throw unsupported or invalid_argument. snapshot()
 * returns only an ID, so the suite cannot read the expiry back; check it in the
 * provider's own tests. Omit it to check only the core's input validation.
 * unsupported skips checks the provider cannot run, with the reason: gitPush for a
 * runtime without git, httpProbe for previews that no HTTP client can reach.
 */
export function runConformance(
  factory: () => Provider | Promise<Provider>,
  options: {
    live: boolean;
    ports?: number[];
    timeoutMs?: number;
    snapshotExpiry?: "honored" | "refused";
    unsupported?: {
      processes?: string;
      previews?: string;
      gitPush?: string;
      httpProbe?: string;
      fileModes?: string;
    };
  },
) {
  const timeout = options.timeoutMs ?? (options.live ? 120_000 : undefined);
  describe("Sandbox SDK conformance", { timeout }, () => {
    const cleanup: SandboxBase<unknown>[] = [];
    const temp: string[] = [];

    // memory and local never reach a cloud account, so they need no live opt-in.
    async function fresh(): Promise<Provider> {
      const provider = await factory();

      if (!options.live && !["memory", "local"].includes(provider.name))
        throw new SandboxError(
          "Live provider refused. live is false. Enable live explicitly with provider credentials.",
          { code: "invalid_argument" },
        );

      return provider;
    }

    async function setup(extra: { trackChanges?: boolean } = {}, provider?: Provider) {
      const target = provider ?? (await fresh());
      const box = await createSandbox(target, { ports: options.ports, ...extra });
      cleanup.push(box);

      return { provider: target, box };
    }

    afterEach(async () => {
      await Promise.all(cleanup.splice(0).map((box) => box.destroy()));
      await Promise.all(temp.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });
    test("create, key lookup, connect and labels", async () => {
      const provider = await fresh();
      const key = `conformance-${crypto.randomUUID()}`;
      const first = await createSandbox(provider, { key, labels: { suite: key } });
      cleanup.push(first);
      const second = await createSandbox(provider, { key });
      cleanup.push(second);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      const reattached = await connectSandbox(provider, first.id);
      cleanup.push(reattached);
      expect(reattached.native).toBeDefined(); // Provider list indexes can lag a fresh create; keyed lookup above must not.
      await expect
        .poll(
          async () =>
            (await listSandboxes(provider, { labels: { suite: key } })).map((box) => box.id),
          { timeout: 15_000, interval: 500 },
        )
        .toEqual([first.id]);
    });
    test("exit results, stdin, resolved cwd and default environment", async () => {
      const { box } = await setup();
      expect(await box.run("false")).toMatchObject({ ok: false, exitCode: 1, timedOut: false });
      expect(await box.run("exit 7")).toMatchObject({ exitCode: 7 });
      expect((await box.run("cat", { stdin: "input\n" })).stdout).toBe("input\n");
      expect((await box.run("pwd")).stdout).toBe("/workspace\n");
      expect(
        (
          await box.run(
            "printf '%s' \"$CI:$PAGER:$GIT_TERMINAL_PROMPT:$DEBIAN_FRONTEND:$TERM:$NO_COLOR\"",
          )
        ).stdout,
      ).toBe("1:cat:0:noninteractive:dumb:1");
    });
    // Two observation windows run back to back, so this case gets more than the default 5 s.
    const killTimeout = Math.max(timeout ?? 0, 30_000);
    test(
      "timeout and abort kill a launched command before its delayed side effect",
      { timeout: killTimeout },
      async () => {
        const { box } = await setup();
        // Size the windows from one round trip: mock-backed suites also pass live: true.
        const began = Date.now();
        await box.run("true");
        const overheadMs = Date.now() - began;
        // Each command writes a launch marker, then a second file after a delay. The kill
        // must come after the marker, or a run cancelled before it started would pass.
        // The command has to launch within its timeout, and the kill to land before the write.
        const timeoutMs = 500 + 2 * overheadMs;
        const delayMs = Math.ceil((timeoutMs + overheadMs + 500) / 1000) * 1000;
        const graceMs = 500 + overheadMs;

        async function launch(name: string, runOptions: RunOptions) {
          const run = Promise.resolve(
            box.run(
              `echo launched > ${name}-launched; sleep ${delayMs / 1000}; echo survived > ${name}-survived`,
              runOptions,
            ),
          );

          await expect
            .poll(() => box.files.exists(`${name}-launched`), { timeout: delayMs, interval: 20 })
            .toBe(true);

          return { run, launchedAt: Date.now() };
        }

        // The command launched before launchedAt, so its write would land by launchedAt + delayMs.
        async function expectNoSideEffect(name: string, launchedAt: number) {
          const wait = launchedAt + delayMs + graceMs - Date.now();
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
          expect(await box.files.exists(`${name}-survived`)).toBe(false);
        }

        const timed = await launch("timeout", { timeoutMs });
        expect(await timed.run).toMatchObject({ timedOut: true, exitCode: null, ok: false });
        await expectNoSideEffect("timeout", timed.launchedAt);

        const controller = new AbortController();
        const aborted = await launch("abort", { signal: controller.signal });
        controller.abort();
        expect(await aborted.run).toMatchObject({ timedOut: true, exitCode: null, ok: false });
        await expectNoSideEffect("abort", aborted.launchedAt);
      },
    );
    test("bounded head and tail output, interleaving and streaming", async () => {
      const { box } = await setup();
      const result = await box.run(`printf '${"a".repeat(1024)}END'`, { maxOutputBytes: 64 });
      expect(result.truncated).toBe(true);
      expect(result.stdout.startsWith("a")).toBe(true);
      expect(result.stdout.endsWith("END")).toBe(true);
      expect(result.stdout).toContain("bytes cut");
      // Separate OS pipes can coalesce writes; compare with actual arrival order.
      const mixed = box.run("printf A; printf B >&2; printf C");
      const arrival: string[] = [];

      for await (const chunk of mixed) arrival.push(chunk.text);
      const resultMixed = await mixed;
      expect(resultMixed).toMatchObject({ stdout: "AC", stderr: "B", output: arrival.join("") });
      const chunks = [];

      for await (const chunk of box.run("echo streamed")) chunks.push(chunk.text);
      expect(chunks.join("")).toBe("streamed\n");
    });
    test("tag escaping and chain options prevent interpolation execution", async () => {
      // Live commands include provider environment setup and network round trips.
      const { box } = await setup();
      const input = "x'; echo injected; printf '";
      expect(
        (
          await box.$`printf '%s' ${input}`
            .cwd(".")
            .env({ X: "ok" })
            .timeout(options.live ? 10_000 : 1000)
        ).stdout,
      ).toBe(input);
      expect((await box.run("printf '%s' \"$X\"")).stdout).toBe("");
    });
    test("all file primitives, exact edits, glob search, checkpoints", async () => {
      const { box } = await setup({ trackChanges: true });
      await box.files.write({
        "app/a.ts": "TODO one\nsecond",
        "app/b.ts": "two two",
        "app/raw": new Uint8Array([0, 255]),
      });
      expect(await box.files.read("app/raw", { as: "bytes" })).toEqual(new Uint8Array([0, 255]));
      expect((await box.files.stat("app/a.ts")).type).toBe("file");
      expect((await box.files.list("app", { recursive: true, glob: "**/*.ts" })).length).toBe(2);
      expect(await box.files.search("TODO", { path: "app", glob: "*.ts" })).toMatchObject([
        { line: 1, text: "TODO one" },
      ]);
      await expect(
        box.files.edit("app/a.ts", { find: "missing", replace: "x" }),
      ).rejects.toMatchObject({ code: "edit_not_found" });
      await expect(box.files.edit("app/b.ts", { find: "two", replace: "x" })).rejects.toMatchObject(
        { code: "edit_not_unique" },
      );
      const mark = await box.files.mark();
      await box.files.edit("app/a.ts", { find: "TODO", replace: "DONE" });
      await box.files.remove("app/b.ts");
      await box.files.write("app/new", "new");
      expect(await box.files.changes({ since: mark })).toMatchObject({
        added: ["/workspace/app/new"],
        modified: ["/workspace/app/a.ts"],
        removed: ["/workspace/app/b.ts"],
      });
      expect((await box.files.changes()).added).toContain("/workspace/app/a.ts");
      await box.files.remove("app", { recursive: true });
      expect(await box.files.exists("app")).toBe(false);
    });
    test("write mode sets permission bits and rejects invalid modes", async (context) => {
      if (options.unsupported?.fileModes) {
        context.skip(options.unsupported.fileModes);

        return;
      }

      const { box } = await setup();
      await box.files.write("modes/secret", "x", { mode: 0o600 });
      await box.files.write({ "modes/a": "a", "modes/b": "b" }, { mode: 0o640 });
      expect((await box.run("stat -c %a modes/secret modes/a modes/b")).stdout).toBe(
        "600\n640\n640\n",
      );

      for (const mode of [-1, 0o10000, 1.5, Number.NaN])
        await expect(box.files.write("modes/bad", "x", { mode })).rejects.toMatchObject({
          code: "invalid_argument",
        });
      expect(await box.files.exists("modes/bad")).toBe(false);
    });
    test("snapshot expiresInMs is validated, forwarded to the provider, and accepted or refused as declared", async (context) => {
      const provider = await fresh();
      const requests = recordSnapshotOptions(provider);
      const { box } = await setup({}, provider);

      if (!hasCapability(box, "snapshot")) {
        context.skip();

        return;
      }

      await expect(box.snapshot({ expiresInMs: -1 })).rejects.toMatchObject({
        code: "invalid_argument",
      });

      // The core rejects the invalid value before the provider sees it.
      expect(requests).toEqual([]);

      // A day, so a provider that honors it cleans the snapshot up itself.
      if (options.snapshotExpiry === "honored") {
        expect((await box.snapshot({ expiresInMs: 86_400_000 })).id).not.toBe("");
        expect(requests).toEqual([{ expiresInMs: 86_400_000 }]);
      } else if (options.snapshotExpiry === "refused") {
        await expect(box.snapshot({ expiresInMs: 86_400_000 })).rejects.toMatchObject({
          name: "SandboxError",
          code: expect.stringMatching(/^(unsupported|invalid_argument)$/),
        });
        expect(requests).toEqual([{ expiresInMs: 86_400_000 }]);
      }
    });
    test("changes without since needs trackChanges or an explicit mark", async () => {
      const { box } = await setup();
      await expect(box.files.changes()).rejects.toMatchObject({
        code: "invalid_argument",
        message: expect.stringContaining("trackChanges: true"),
      });
      await box.files.write("late", "x");
      const mark = await box.files.mark("start");
      await box.files.write("late", "y");
      expect((await box.files.changes()).modified).toEqual(["/workspace/late"]);
      expect((await box.files.changes({ since: mark })).modified).toEqual(["/workspace/late"]);
    });
    test("upload/download round trip with ignores", async () => {
      const { box } = await setup();
      const path = await mkdtemp(join(tmpdir(), "sdk-conformance-"));
      temp.push(path);
      await mkdir(join(path, "source"));
      await writeFile(join(path, "source", "keep"), "hello");
      await writeFile(join(path, "source", "ignore"), "no");
      await box.files.upload(join(path, "source"), "upload", { ignore: ["ignore"] });
      expect(await box.files.exists("upload/ignore")).toBe(false);
      await box.files.download("upload", join(path, "download"));
      expect(await readFile(join(path, "download", "keep"), "utf8")).toBe("hello");
    });
    // Each poll is a write plus a watch scan, two round trips on a remote provider.
    test("file watch observes changes", { timeout: Math.max(timeout ?? 0, 60_000) }, async () => {
      const { box } = await setup();
      const began = Date.now();
      await box.files.write("watch/file", "a");
      const writeMs = Date.now() - began;
      const events: string[] = [];

      const stop = box.files.watch("watch", (event) => events.push(event.type), {
        recursive: true,
        intervalMs: 10,
      });

      let writes = 0;

      try {
        await expect
          .poll(
            async () => {
              await box.files.write("watch/file", `different-${writes++}`);

              return events;
            },
            { timeout: Math.max(10_000, 20 * writeMs), interval: 50 },
          )
          .toContain("modified");
      } finally {
        stop();
      }
    });
    test("process logs, cursors, fresh client reattach, stop and exit-before-ready", async (context) => {
      if (options.unsupported?.processes) {
        context.skip(options.unsupported.processes);

        return;
      }

      const { box } = await setup();

      const process = await box.start("echo READY; sleep 5", {
        name: "dev",
        ready: { log: /READY/ },
        readyTimeoutMs: 2000,
      });

      expect(process.ready).toBe(true);
      const page = await process.logs();
      expect(page.text).toContain("READY");
      expect((await process.logs({ after: page.nextCursor })).text).toBe("");
      // A new provider instance, so reattach cannot lean on the first client's memory.
      const client = await connectSandbox(await fresh(), box.id);
      cleanup.push(client);
      expect((await client.processes()).map((process) => process.name)).toContain("dev");
      expect((await client.process("dev").logs()).text).toContain("READY");
      await client.process("dev").stop({ graceMs: 10 });
      expect((await process.wait()).exitCode).not.toBe(null);
      await expect(
        box.start("exit 3", { name: "early", ready: { log: /never/ }, readyTimeoutMs: 1000 }),
      ).rejects.toMatchObject({ code: "process_exited" });
    });
    test("readiness timeout preserves the process", async (context) => {
      if (options.unsupported?.processes) {
        context.skip(options.unsupported.processes);

        return;
      }

      const { box } = await setup();
      await expect(
        box.start("sleep 5", { name: "unready", ready: { log: /never/ }, readyTimeoutMs: 30 }),
      ).rejects.toMatchObject({ code: "timeout" });
      expect(box.process("unready").ready).toBe(false);
      expect((await box.processes())[0]?.status).toBe("running");
      await box.process("unready").stop({ graceMs: 10 });
    });
    test("preview and capability gating", async () => {
      const { provider, box } = await setup();

      if (options.unsupported?.previews)
        await expect(box.preview(3000)).rejects.toMatchObject({ code: "unsupported" });
      else expect(["http:", "https:"]).toContain(new URL((await box.preview(3000)).url).protocol);

      for (const [capability, method] of [
        ["pause", "pause"],
        ["snapshot", "snapshot"],
        ["terminal", "terminal"],
      ] as const)
        expect(method in box).toBe(provider.capabilities.has(capability));

      if (!provider.capabilities.has("network-policy"))
        await expect(createSandbox(provider, { network: "none" })).rejects.toMatchObject({
          code: "unsupported",
        });

      if (!provider.capabilities.has("size"))
        await expect(createSandbox(provider, { size: "small" })).rejects.toMatchObject({
          code: "unsupported",
        });
    });
    test("close, disposal, destroy and label-scoped reaping", async () => {
      const { provider, box } = await setup();
      const id = box.id;
      await box.close();
      expect((await connectSandbox(provider, id)).id).toBe(id);
      await box.destroy();
      await expect(connectSandbox(provider, id)).rejects.toMatchObject({ code: "not_found" });
      const key = crypto.randomUUID();
      const keyed = await createSandbox(provider, { key, labels: { reap: key } });
      cleanup.push(keyed);
      await keyed[Symbol.asyncDispose]();
      expect((await provider.connect(keyed.id)).id).toBe(keyed.id);
      expect(await reapSandboxes(provider, { labels: { reap: key }, olderThanMs: 0 })).toBe(1);
      const ephemeral = await createSandbox(provider);
      await ephemeral[Symbol.asyncDispose]();
      await expect(provider.connect(ephemeral.id)).rejects.toMatchObject({ code: "not_found" });
    });
    test("usage counters", async () => {
      const { box } = await setup();
      await box.run("echo abc");
      expect(await box.usage()).toMatchObject({ commands: 1, bytesOut: 4 });
    });
    test("local bare git clone, commit and push (live providers only)", async (context) => {
      if (options.unsupported?.gitPush) {
        context.skip(options.unsupported.gitPush);

        return;
      }

      const { box } = await setup();
      expect((await box.run("git init --bare /tmp/sdk-bare")).ok).toBe(true);
      expect((await box.git.clone("/tmp/sdk-bare", { dir: "repo" })).ok).toBe(true);
      await box.run("git config user.name Conformance; git config user.email test@example.com", {
        cwd: "repo",
      });
      await box.files.write("repo/test", "test");
      expect((await box.git.commit("repo", { message: "conformance", all: true })).ok).toBe(true);
      expect((await box.git.status("repo")).stdout).toBe("");
      expect((await box.git.push("repo", { branch: "HEAD" })).ok).toBe(true);
    });
    test("real HTTP preview probe (live Linux providers only)", async (context) => {
      const skip = options.unsupported?.previews ?? options.unsupported?.httpProbe;

      if (skip) {
        context.skip(skip);

        return;
      }

      const { box } = await setup();

      const proc = await box.start(
        'node -e \'require("http").createServer((_,r)=>r.end("ok")).listen(3000,"0.0.0.0")\'',
        { name: "http", ready: { http: { port: 3000 } } },
      );

      expect(proc.ready).toBe(true);
      expect((await box.preview(3000, { waitMs: 2000 })).url).toBeTruthy();
      await proc.stop();
    });
  });
}

/** Record the options each snapshot call hands the provider, still calling through. */
function recordSnapshotOptions(provider: Provider): (SnapshotOptions | undefined)[] {
  const requests: (SnapshotOptions | undefined)[] = [];
  const snapshot = provider.snapshot;

  if (snapshot)
    provider.snapshot = (id, options) => {
      requests.push(options);

      return snapshot.call(provider, id, options);
    };

  return requests;
}

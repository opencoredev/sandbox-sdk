import { test, expect } from "vitest";
import { agentos } from "../src/providers/agentos/index.js";
import { createSandbox, connectSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";

if (process.env.SANDBOX_AGENTOS_LIVE === "1") {
  runConformance(() => agentos(), {
    live: true,
    unsupported: {
      gitPush: "agentOS 0.4.1 local Git push stalls; clone and commit are tested separately",
      processes:
        "The SDK's persistent process shim requires unsupported shell process-group/FIFO behavior; native.process.spawn is available",
      previews:
        "Embedded agentOS has VM-local ports and no preview URLs; native.network.httpRequest is available",
    },
  });
  test("local Git clone and commit without unsupported push", async () => {
    const box = await createSandbox(agentos());

    try {
      expect((await box.run("git init --bare /tmp/sdk-bare")).ok).toBe(true);
      expect((await box.git.clone("/tmp/sdk-bare", { dir: "repo" })).ok).toBe(true);
      await box.run("git config user.name Conformance; git config user.email test@example.com", {
        cwd: "repo",
      });
      await box.files.write("repo/test", "test");
      expect((await box.git.commit("repo", { message: "conformance", all: true })).ok).toBe(true);
      expect((await box.git.status("repo")).stdout).toBe("");
    } finally {
      await box.destroy();
    }
  }, 120_000);
  test("native Node, npm, isolated filesystem and fresh-factory identity", async () => {
    const box = await createSandbox(agentos(), {
      env: { INITIAL: "hello" },
      network: "none",
      key: crypto.randomUUID(),
    });

    try {
      expect((await box.run("node -e 'console.log(6*7)'")).stdout).toBe("42\n");
      expect((await box.run("npm --version")).ok).toBe(true);
      expect((await box.run("printf '%s' \"$INITIAL\"")).stdout).toBe("hello");
      const fresh = await connectSandbox(agentos(), box.id);
      expect(fresh.native).toBe(box.native);
      await fresh.close();
      await expect(box.start("echo READY; sleep 5", { name: "dev" })).rejects.toMatchObject({
        code: "unsupported",
      });
      await expect(box.preview(3000)).rejects.toMatchObject({ code: "unsupported" });
    } finally {
      await box.destroy();
    }
  }, 120_000);
  test("egress allowlists permit the listed host and deny other hosts", async () => {
    const box = await createSandbox(agentos(), { network: { allow: ["registry.npmjs.org"] } });

    try {
      const request = (url: string) =>
        `node -e 'fetch("${url}").then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log("DENIED");process.exit(0)})'`;

      expect(
        (
          await box.run(request("https://registry.npmjs.org/is-number/latest"), {
            timeoutMs: 30_000,
          })
        ).stdout.trim(),
      ).toBe("200");
      expect(
        (await box.run(request("https://example.com"), { timeoutMs: 30_000 })).stdout.trim(),
      ).toBe("DENIED");
    } finally {
      await box.destroy();
    }
  }, 120_000);
  test("native VM-local HTTP reaches a guest listener", async () => {
    const box = await createSandbox(agentos());

    try {
      let ready = false;

      const process = await box.native.process.spawn(
        "node",
        [
          "-e",
          'require("node:http").createServer((_,r)=>r.end("native-ok")).listen(3000,"0.0.0.0",()=>console.log("READY"))',
        ],
        {
          onStdout(data) {
            if (new TextDecoder().decode(data).includes("READY")) ready = true;
          },
        },
      );

      try {
        await expect.poll(() => ready, { timeout: 30_000 }).toBe(true);
        expect(
          new TextDecoder().decode(
            (await box.native.network.httpRequest({ port: 3000, path: "/" })).body,
          ),
        ).toBe("native-ok");
      } finally {
        await box.native.process.kill(process.pid);
      }
    } finally {
      await box.destroy();
    }
  }, 120_000);
  test("timeout and abort kill descendants before delayed side effects", async () => {
    const box = await createSandbox(agentos());

    try {
      for (const kind of ["timeout", "abort"]) {
        const controller = new AbortController();
        const timer = kind === "abort" ? setTimeout(() => controller.abort(), 100) : undefined;

        try {
          expect(
            await box.run(`(sleep .5; echo leak > ${kind}) & wait`, {
              timeoutMs: kind === "timeout" ? 100 : 3000,
              signal: controller.signal,
            }),
          ).toMatchObject({ timedOut: true, exitCode: null });
        } finally {
          clearTimeout(timer);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(await box.files.exists("timeout")).toBe(false);
      expect(await box.files.exists("abort")).toBe(false);
    } finally {
      await box.destroy();
    }
  }, 120_000);

  test("symlinks and dangling links retain metadata without recursive traversal", async () => {
    const box = await createSandbox(agentos());

    try {
      expect(
        (await box.run("mkdir links; ln -s . links/loop; ln -s missing links/dangling")).ok,
      ).toBe(true);
      const items = await box.files.list("links", { recursive: true });
      expect(items).toHaveLength(2);
      expect(
        items.every((item) => item.type === "symlink" && Number.isFinite(item.modifiedAt)),
      ).toBe(true);
      expect(await box.files.stat("links/loop")).toMatchObject({ type: "symlink" });
      expect(await box.files.stat("links/dangling")).toMatchObject({ type: "symlink" });
      await expect(
        box.files.download("links", "/tmp/sbx40-symlink-rejected"),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    } finally {
      await box.destroy();
    }
  }, 120_000);
} else
  test.skip("agentOS live suite requires SANDBOX_AGENTOS_LIVE=1 (no account or Docker required)", () => {});

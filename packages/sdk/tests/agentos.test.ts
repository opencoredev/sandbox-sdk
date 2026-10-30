import { vi, test, expect } from "vitest";

import * as mock from "./agentos-mock.js";
import { agentos } from "./agentos-mock.js";
import { local } from "../src/providers/local/index.js";
import { createSandbox, connectSandbox, type CreateOptions } from "../src/index.js";
import { runConformance } from "../src/testing.js";
import { agentosError } from "../src/providers/agentos/errors.js";

runConformance(agentos, {
  live: true,
  unsupported: {
    processes: "agentOS does not implement the SDK persistent process shim",
    previews: "Embedded agentOS has no preview URL service",
  },
});

test("Docker stays default; agentOS is lazy and loads the pinned Git package", async () => {
  expect(local().name).toBe("local");
  const before = mock.creates.length;
  const provider = agentos();
  expect(mock.creates).toHaveLength(before);
  const box = await createSandbox(provider);

  try {
    expect(mock.installs.at(-1)).toMatchObject({
      type: "url",
      expectedDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(box.native).toBeInstanceOf(mock.MockAgentOs);
  } finally {
    await box.destroy();
  }
});

test("all factories share keyed VMs and parallel creation is exact within one process", async () => {
  const key = crypto.randomUUID();

  const boxes = await Promise.all(
    Array.from({ length: 5 }, () => createSandbox(agentos(), { key })),
  );

  try {
    expect(new Set(boxes.map((box) => box.id)).size).toBe(1);
    expect(boxes.filter((box) => box.created)).toHaveLength(1);
    const fresh = await connectSandbox(agentos(), boxes[0]?.id ?? "");
    await fresh.close();
    const first = boxes[0];

    if (!first) throw new Error("Expected sandbox");
    expect((await first.run("echo connected")).ok).toBe(true);
  } finally {
    await boxes[0]?.destroy();
  }
});

test("network policies are explicit and unsupported options fail closed", async () => {
  for (const network of ["all", "none", { allow: ["registry.npmjs.org"] }] as const) {
    const box = await createSandbox(agentos(), {
      network: network === "all" || network === "none" ? network : { allow: [...network.allow] },
    });

    try {
      expect(mock.creates.at(-1)?.permissions?.network).toEqual(
        network === "all"
          ? "allow"
          : network === "none"
            ? "deny"
            : {
                default: "deny",
                rules: [
                  {
                    mode: "allow",
                    operations: ["*"],
                    patterns: ["dns://registry.npmjs.org", "tcp://registry.npmjs.org:*"],
                  },
                ],
              },
      );
    } finally {
      await box.destroy();
    }
  }

  for (const options of [
    { size: "small" },
    { from: "snapshot" },
    { idleTimeoutMs: 1000 },
    { timeoutMs: 1000 },
    { network: { allow: ["*.example.com"] } },
  ] satisfies CreateOptions[]) {
    await expect(createSandbox(agentos(), options)).rejects.toMatchObject({ code: "unsupported" });
  }
});

test("native failures are sanitized and unsupported SDK processes/previews are clear", async () => {
  const box = await createSandbox(agentos());

  try {
    await expect(box.files.read("missing")).rejects.toMatchObject({ code: "file_not_found" });
    await expect(box.start("echo hi", { name: "dev" })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(await box.processes()).toEqual([]);
    await expect(box.start("echo again", { name: "dev" })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(box.preview(3000)).rejects.toMatchObject({ code: "unsupported" });
    expect(box.capabilities).toEqual(new Set(["network-policy"]));
    // Unmapped native failures keep their scrubbed text as cause and in the message; credential-shaped values never survive.
    const native = agentosError(new Error("sidecar crashed; password=secret-sensitive"));
    expect(native).toMatchObject({
      code: "provider",
      cause: "Error: sidecar crashed; password=[REDACTED]",
    });
    expect(String(native)).toContain("sidecar crashed");
    expect(String(native)).not.toContain("secret-sensitive");
  } finally {
    await box.destroy();
  }
});

test("symlinks and dangling links retain metadata without recursive traversal", async () => {
  const box = await createSandbox(agentos());

  try {
    expect(
      (await box.run("mkdir links; ln -s . links/loop; ln -s missing links/dangling")).ok,
    ).toBe(true);
    expect(await box.files.stat("links/loop")).toMatchObject({ type: "symlink" });
    expect(await box.files.stat("links/dangling")).toMatchObject({ type: "symlink" });
    const items = await box.files.list("links", { recursive: true });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.type === "symlink" && Number.isFinite(item.modifiedAt))).toBe(
      true,
    );
    await expect(box.files.download("links", "/tmp/sbx40-symlink-rejected")).rejects.toMatchObject({
      code: "invalid_argument",
    });
  } finally {
    await box.destroy();
  }
}, 120_000);

test("nested writes create parents once and recover after guest removal", async () => {
  const box = await createSandbox(agentos());
  const mkdir = vi.spyOn(box.native.filesystem, "mkdir");

  try {
    await box.files.write("nested/deep/file", "first");
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(await box.files.read("nested/deep/file")).toBe("first");
    await box.run("rm -rf nested");
    mkdir.mockClear();
    await box.files.write("nested/deep/file", "second");
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(await box.files.read("nested/deep/file")).toBe("second");
  } finally {
    mkdir.mockRestore();
    await box.destroy();
  }
});

test("public run uses the process-local activity registry without another guest shell", async () => {
  const box = await createSandbox(agentos());
  const exec = vi.spyOn(box.native.process, "exec");

  try {
    expect((await box.run("printf direct")).stdout).toBe("direct");
    expect(exec).toHaveBeenCalledWith(
      "exec < /dev/null\nprintf direct",
      expect.objectContaining({ cwd: "/workspace" }),
    );
    expect(await box.files.exists("/tmp/.sandbox-sdk/runs")).toBe(false);
  } finally {
    exec.mockRestore();
    await box.destroy();
  }
});

test("idle reaping sees public runs through a fresh adapter factory", async () => {
  const { reapSandboxes } = await import("../src/index.js");
  const labels = { sbx57: crypto.randomUUID() };
  const box = await createSandbox(agentos(), { labels });
  let ready = () => {};

  const running = new Promise<void>((resolve) => {
    ready = resolve;
  });

  const run = (async () => {
    for await (const chunk of box.run("echo READY; sleep .2"))
      if (chunk.text.includes("READY")) ready();
  })();

  try {
    await running;
    expect(await reapSandboxes(agentos(), { labels, olderThanMs: 0, idleOnly: true })).toBe(0);
    await run;
    expect(await reapSandboxes(agentos(), { labels, olderThanMs: 0, idleOnly: true })).toBe(1);
  } finally {
    await run;
    await box.destroy();
  }
});

test("native software, mounts and limits reach AgentOs.create unchanged (SBX-71)", async () => {
  const mounts = [
    {
      path: "/data",
      plugin: { id: "host_dir", config: { hostPath: "/srv/data", readOnly: true } },
      readOnly: true,
    },
  ];

  const options = {
    software: [{ packagePath: "/pkgs/python" }],
    mounts,
    limits: { resources: { maxProcesses: 32, maxFilesystemBytes: 1 << 20 } },
  } as const satisfies Omit<
    import("../src/providers/agentos/index.js").AgentosOptions,
    "gitPackagePath"
  >;

  const box = await createSandbox(agentos(options), { env: { A: "1" } });

  try {
    expect(mock.creates.at(-1)).toMatchObject({
      ...options,
      environment: { HOME: "/home/agentos", A: "1" },
    });
  } finally {
    await box.destroy();
  }

  const plain = await createSandbox(agentos());

  try {
    for (const key of ["software", "mounts", "limits"])
      expect(mock.creates.at(-1)).not.toHaveProperty(key);
  } finally {
    await plain.destroy();
  }
});

test("agentOS applies write modes through the VM's Node fs", async () => {
  const provider = agentos();
  expect(provider.files.writeSupportsMode).toBe(true);
  const box = await createSandbox(provider);

  try {
    const evaluate = vi.spyOn(box.native.javascript, "evaluate");
    await provider.files.write(box.id, "/workspace/secret", new TextEncoder().encode("x"), {
      mode: 0o600,
    });
    await provider.files.write(box.id, "/workspace/plain", new TextEncoder().encode("x"));
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[0]).toContain(`chmodSync("/workspace/secret", ${0o600})`);
    expect((await box.run("stat -c %a secret")).stdout.trim()).toBe("600");
    evaluate.mockRestore();
  } finally {
    await box.destroy();
  }
});

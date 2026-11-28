import { describe, expect, test, vi } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { agent37, type Agent37Options } from "../src/providers/agent37/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.AGENT37_API_KEY);

if (credentials) vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `agent37-${Date.now()}`;

// Every live sandbox carries this run's label, so a sweep can find what a failed run left behind.
function liveProvider(options: Agent37Options = {}) {
  const provider = agent37(options);
  const create = provider.create;

  provider.create = (input) => create({ ...input, labels: { ...input.labels, live_run: run } });

  return provider;
}

describe.skipIf(!credentials)("Agent 37 live (billable)", () => {
  runConformance(() => liveProvider(), {
    live: true,
    ports: [3000],
    timeoutMs: 600_000,
    snapshotExpiry: "refused",
  });
});

describe.skipIf(!credentials)("Agent 37 live options", { timeout: 900_000 }, () => {
  test("a size that is not one of Agent 37's shapes is refused before anything is made", async () => {
    await expect(
      createSandbox(liveProvider(), { size: { cpu: 3, memoryMb: 6144 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  test("timeoutMs is refused: instances have no time limit", async () => {
    await expect(createSandbox(liveProvider(), { timeoutMs: 60_000 })).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  test("medium is 4 vCPU and 8 GiB", async () => {
    await using box = await createSandbox(liveProvider(), { size: "medium" });
    const result = await box.run("nproc; awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo");
    const [cpus, mib] = result.stdout.trim().split("\n").map(Number);

    expect(cpus).toBe(4);
    expect(mib).toBeGreaterThan(7000);
  });

  test("a public preview serves without a credential", async () => {
    await using box = await createSandbox(liveProvider({ public: true }));
    await box.files.write("site/index.html", "hello-agent37\n");
    await box.run("cd /workspace/site && nohup python3 -m http.server 3000 >/dev/null 2>&1 &");
    const preview = await box.preview(3000, { waitMs: 30_000 });
    const answer = await fetch(preview.url);

    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe("hello-agent37\n");
  });
});

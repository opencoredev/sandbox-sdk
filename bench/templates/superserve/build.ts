import { Template } from "@superserve/sdk";

async function main() {
  const [size = "1x1", ...extra] = process.argv.slice(2);
  if ((size !== "1x1" && size !== "4x8") || extra.length > 0) {
    throw new Error("Usage: bun build.ts [1x1|4x8]");
  }
  const apiKey = process.env.SUPERSERVE_API_KEY;
  if (!apiKey?.trim()) throw new Error("Set SUPERSERVE_API_KEY");

  const template = await Template.create({
    apiKey,
    name: `sandbox-bench-node22-py311-${size}`,
    from: "node:22-bookworm-slim",
    vcpu: size === "1x1" ? 1 : 4,
    memoryMib: size === "1x1" ? 1024 : 8192,
    diskMib: 4096,
    steps: [
      {
        run: "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends python3 python3-venv python3-pip git tar coreutils procps ca-certificates && rm -rf /var/lib/apt/lists/*",
      },
      { run: "mkdir -p /dev/shm /workspace && chmod 1777 /dev/shm" },
      {
        run: 'for tool in node npm python3 git tar nohup; do command -v "$tool" || exit 1; done && python3 -c "import multiprocessing; multiprocessing.Lock()"',
      },
    ],
    signal: AbortSignal.timeout(60_000),
  });
  const ready = await template.waitUntilReady({ signal: AbortSignal.timeout(15 * 60_000) });
  if (ready.status !== "ready") throw new Error("Template did not become ready");
  process.stdout.write(`${ready.name}\n`);
}

main().catch((error: unknown) => {
  // Native errors can contain credentials; emit only safe diagnostics.
  const message = error instanceof Error ? error.message : "";
  if (message.includes("vcpu must be 1-2")) {
    process.stderr.write("BLOCKED: vcpu must be 1-2 (your team's limit)\n");
  } else {
    process.stderr.write(
      "Template build failed. Check the size argument, credentials, and Superserve build status.\n",
    );
  }
  process.exitCode = 1;
});

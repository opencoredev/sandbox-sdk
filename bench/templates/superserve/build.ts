import { Sandbox, Template } from "@superserve/sdk";

async function main() {
  const [size = "1x1", ...extra] = process.argv.slice(2);

  if ((size !== "1x1" && size !== "4x8") || extra.length > 0) {
    throw new Error("Usage: bun build.ts [1x1|4x8]");
  }

  const apiKey = process.env.SUPERSERVE_API_KEY;

  if (!apiKey?.trim()) throw new Error("Set SUPERSERVE_API_KEY");

  const template = await Template.create({
    apiKey,
    name: `sandbox-bench-node22-py311-${size}-pinned`,
    // The version tag is informational; the digest is the immutable build input.
    from: "node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d",
    vcpu: size === "1x1" ? 1 : 4,
    memoryMib: size === "1x1" ? 1024 : 8192,
    diskMib: 4096,
    steps: [
      {
        run: `printf '%s\\n' 'Types: deb' 'URIs: http://snapshot.debian.org/archive/debian/20261022T000000Z/' 'Suites: bookworm bookworm-updates' 'Components: main' 'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' 'Check-Valid-Until: no' '' 'Types: deb' 'URIs: http://snapshot.debian.org/archive/debian-security/20261022T000000Z/' 'Suites: bookworm-security' 'Components: main' 'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' 'Check-Valid-Until: no' > /etc/apt/sources.list.d/debian.sources`,
      },
      {
        run: "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends python3=3.11.2-1+b1 python3-venv=3.11.2-1+b1 python3-pip=23.0.1+dfsg-1 git=1:2.39.5-0+deb12u3 tar=1.34+dfsg-1.2+deb12u1 coreutils=9.1-1 procps=2:4.0.2-3 ca-certificates=20250419~deb12u2 && rm -rf /var/lib/apt/lists/*",
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

  // Verify the resulting runtime, rather than reporting versions inferred from tags.
  const sandbox = await Sandbox.create({
    apiKey,
    name: `sbx53-template-verify-${crypto.randomUUID()}`,
    fromTemplate: ready.id,
    metadata: { verification: "sbx53-pinned-template" },
    signal: AbortSignal.timeout(60_000),
  });

  try {
    const result = await sandbox.commands.run(
      "node --version && npm --version && python3 --version",
      { timeoutMs: 10_000 },
    );

    const versions = result.stdout.trim().split("\n");

    if (result.exitCode !== 0 || versions.join("\n") !== "v22.23.4\n10.9.9\nPython 3.11.2") {
      throw new Error("Runtime versions did not match the pinned template");
    }

    process.stdout.write(
      `${ready.name}\nNode ${versions[0]}\nnpm ${versions[1]}\n${versions[2]}\n`,
    );
  } finally {
    await sandbox.kill({ signal: AbortSignal.timeout(60_000) });
  }
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

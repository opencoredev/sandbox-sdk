import { readFile } from "node:fs/promises";
import { SandboxClient } from "@basetenlabs/sandbox";

/** The image name the bench passes as `--template baseten=sandbox-bench-node-python:latest`. */
const name = "sandbox-bench-node-python";

async function main() {
  if (process.argv.length > 2) throw new Error("Usage: bun build.ts");

  const apiKey = process.env.BASETEN_API_KEY;

  if (!apiKey?.trim()) throw new Error("Set BASETEN_API_KEY");

  const client = new SandboxClient({ apiKey });
  const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url));

  // Pushing to an existing name adds a version; `:latest` then points at it.
  const image = await client.images.push({
    name,
    files: { Dockerfile: dockerfile },
    timeoutMs: 15 * 60_000,
  });

  if (image.status !== "BUILT") throw new Error("Image did not build");

  // Verify the runtime the bench needs, rather than trusting the Dockerfile.
  const sandbox = await client.create({
    name: `sandbox-bench-verify-${crypto.randomUUID().slice(0, 8)}`,
    image: `${name}:latest`,
    labels: { verification: "sandbox-bench-image" },
  });

  try {
    const result = await sandbox.process.exec({
      command:
        "node --version && npm --version && python3 --version && git --version && sed --version | head -1",
      waitForCompletion: true,
      timeoutMs: 30_000,
    });

    const lines = result.stdout.trim().split("\n");

    if (result.exitCode !== 0 || lines.length !== 5 || !lines[4]!.includes("GNU sed")) {
      throw new Error("The image lacks Node, Python, git or GNU sed");
    }

    process.stdout.write(`${name}:latest\n${lines.join("\n")}\n`);
  } finally {
    await client.delete({ name: sandbox.name });
  }
}

try {
  await main();
} catch (error) {
  // Native errors can contain credentials; emit only safe diagnostics.
  process.stderr.write(
    `Image build failed: ${error instanceof Error ? error.name : "unknown error"}. Check BASETEN_API_KEY and the build logs (baseten sandbox image logs --name ${name}).\n`,
  );
  process.exitCode = 1;
}

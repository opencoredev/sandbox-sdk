// Download a URL to a file and refuse it unless its sha256 matches. Runs on the uploaded Node, so
// it works in images without curl. Prints one JSON line. Usage: node fetch.mjs URL SHA256 DEST
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const [url, expected, dest] = process.argv.slice(2);
const started = performance.now();
const partial = `${dest}.partial`;
let lastError = "";

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });

    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const hash = createHash("sha256");
    let bytes = 0;

    const counted = Readable.fromWeb(response.body).on("data", (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });

    await pipeline(counted, createWriteStream(partial));
    const actual = hash.digest("hex");

    if (actual !== expected) {
      await rm(partial, { force: true });
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: `sha256 ${actual}, expected ${expected}`, bytes })}\n`,
      );
      process.exit(2);
    }

    await rename(partial, dest);
    const ms = Math.round(performance.now() - started);
    process.stdout.write(`${JSON.stringify({ ok: true, bytes, ms, attempts: attempt })}\n`);
    process.exit(0);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    await rm(partial, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
}

process.stdout.write(`${JSON.stringify({ ok: false, error: lastError })}\n`);

process.exit(1);

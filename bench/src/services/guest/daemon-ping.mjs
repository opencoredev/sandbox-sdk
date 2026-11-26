// Is a Docker-API daemon answering on this unix socket? Readiness is GET /_ping alone, and the helper
// exits right after it. With --meta (run after the timed steps) it also reads /version and /info for
// the record, best effort, within 3 s of wall clock. Works for dockerd and podman's Docker-compatible service, with or without a docker CLI.
// Prints one JSON line; exit 0 only when /_ping answers OK. Usage: node daemon-ping.mjs SOCKET [--meta]
import { request } from "node:http";

const socketPath = process.argv[2] ?? "/var/run/docker.sock";

function get(path) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "GET", timeout: 5000 }, (res) => {
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
      );
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response aborted")));
    });

    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

// The harness parses these fields with its own schema (attempt.ts pingSchema).
async function field(path, key) {
  try {
    return JSON.parse((await get(path)).body)[key] ?? null;
  } catch {
    return null;
  }
}

let ping;

try {
  ping = await get("/_ping");
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
}

if (ping.status !== 200) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: `/_ping HTTP ${ping.status}` })}\n`);
  process.exit(1);
}

const pingedMs = Math.round(performance.now());
const metadata = { serverVersion: null, storageDriver: null };

// Readiness calls stop here; `--meta` (run after the timed steps) also reads version and driver.
if (process.argv[3] !== "--meta") {
  process.stdout.write(`${JSON.stringify({ ok: true, pingedMs, ...metadata })}\n`);
  process.exit(0);
}

let written = false;

function finish() {
  if (written) return;
  written = true;
  process.stdout.write(`${JSON.stringify({ ok: true, pingedMs, ...metadata })}\n`);
  process.exit(0);
}

setTimeout(finish, 3000);

metadata.serverVersion = await field("/version", "Version");

metadata.storageDriver = await field("/info", "Driver");

finish();

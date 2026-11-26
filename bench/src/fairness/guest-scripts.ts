/**
 * Small guest programs for state-survival and memory-pressure, in the two runtimes nearly every
 * sandbox image ships: Node first, Python 3 second. Each check uploads the one the guest has.
 *
 * `state` modes (argv after the script):
 * - `serve PORT PIDFILE`: holds 32 MiB of random bytes and a random token in memory, writes its pid
 *   to PIDFILE once listening on 127.0.0.1:PORT, and answers GET / with
 *   `{token, pid, digestAtStart, digestNow, upMs}`. A restarted server has a new token, and a
 *   server whose memory changed has `digestNow !== digestAtStart`.
 * - `probe PORT TIMEOUT_MS`: polls GET / until it answers; prints `{ok, ms, body}`.
 * - `restart PORT PIDFILE LOG TIMEOUT_MS`: SIGKILLs the server in PIDFILE, starts a new one in its
 *   own session, and prints `{ok, ms, body}` once a different pid answers; `ms` runs from the kill.
 *
 * `hog TARGET_MIB CHUNK_MIB`: allocates CHUNK_MIB at a time, fills each chunk with random bytes so
 * no compression or page merging can shrink it, and prints `held MIB MS` after each chunk,
 * `reached MIB MS` at the target (then holds 3 s and exits 0), or `refused MIB REASON` and exit 3
 * when the runtime's allocation fails.
 */
import { quote } from "../workloads.js";

export const runtimes = ["node", "python3"] as const;

export type Runtime = (typeof runtimes)[number];

const nodeState = `
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const cp = require("child_process");
const [mode, ...args] = process.argv.slice(2);
const now = () => performance.now();

function serve(port, pidfile) {
  const buf = crypto.randomBytes(32 << 20);
  const digest = () => crypto.createHash("sha256").update(buf).digest("hex");
  const token = crypto.randomBytes(16).toString("hex");
  const digestAtStart = digest();
  const started = Date.now();
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token, pid: process.pid, digestAtStart, digestNow: digest(), upMs: Date.now() - started }));
  });
  let tries = 0;
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && tries++ < 500) setTimeout(() => server.listen(port, "127.0.0.1"), 10);
    else process.exit(2);
  });
  server.listen(port, "127.0.0.1", () => {
    fs.writeFileSync(pidfile, String(process.pid));
    console.log("ready " + token);
  });
}

function get(port, timeoutMs) {
  return new Promise((done) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        try { done(JSON.parse(text)); } catch { done(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); done(null); });
    req.on("error", () => done(null));
  });
}

async function poll(port, start, timeoutMs, notPid) {
  for (;;) {
    const body = await get(port, 250);
    const ms = Math.round((now() - start) * 10) / 10;
    if (body && body.pid !== notPid) return { ok: true, ms, body };
    if (now() - start > timeoutMs) return { ok: false, ms, body: null };
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function main() {
  if (mode === "serve") return serve(Number(args[0]), args[1]);
  if (mode === "probe") return console.log(JSON.stringify(await poll(Number(args[0]), now(), Number(args[1]), -1)));
  if (mode === "restart") {
    const [port, pidfile, log, timeoutMs] = args;
    let old = -1;
    try { old = Number(fs.readFileSync(pidfile, "utf8")); } catch {}
    const start = now();
    try { process.kill(old, "SIGKILL"); } catch {}
    const out = fs.openSync(log, "a");
    cp.spawn(process.execPath, [__filename, "serve", port, pidfile], { detached: true, stdio: ["ignore", out, out] }).unref();
    return console.log(JSON.stringify(await poll(Number(port), start, Number(timeoutMs), old)));
  }
  process.exit(64);
}
main();
`;

const pythonState = `
import hashlib, http.server, json, os, secrets, signal, subprocess, sys, time, urllib.request

def serve(port, pidfile):
    buf = bytearray(os.urandom(32 << 20))
    digest = lambda: hashlib.sha256(buf).hexdigest()
    token = secrets.token_hex(16)
    at_start = digest()
    started = time.time()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"token": token, "pid": os.getpid(), "digestAtStart": at_start,
                               "digestNow": digest(), "upMs": int((time.time() - started) * 1000)}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    for _ in range(500):
        try:
            server = http.server.HTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            time.sleep(0.01)
    else:
        sys.exit(2)
    with open(pidfile, "w") as f:
        f.write(str(os.getpid()))
    print("ready", token, flush=True)
    server.serve_forever()

def get(port, timeout):
    try:
        return json.loads(urllib.request.urlopen("http://127.0.0.1:%d/" % port, timeout=timeout).read())
    except Exception:
        return None

def poll(port, start, timeout_ms, not_pid):
    while True:
        body = get(port, 0.25)
        ms = round((time.monotonic() - start) * 1000, 1)
        if body is not None and body.get("pid") != not_pid:
            return {"ok": True, "ms": ms, "body": body}
        if ms > timeout_ms:
            return {"ok": False, "ms": ms, "body": None}
        time.sleep(0.005)

mode, args = sys.argv[1], sys.argv[2:]
if mode == "serve":
    serve(int(args[0]), args[1])
elif mode == "probe":
    print(json.dumps(poll(int(args[0]), time.monotonic(), float(args[1]), -1)))
elif mode == "restart":
    port, pidfile, log, timeout_ms = args
    try:
        old = int(open(pidfile).read())
    except Exception:
        old = -1
    start = time.monotonic()
    try:
        os.kill(old, signal.SIGKILL)
    except Exception:
        pass
    out = open(log, "a")
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "serve", port, pidfile], stdin=subprocess.DEVNULL,
                     stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    print(json.dumps(poll(int(port), start, float(timeout_ms), old)))
else:
    sys.exit(64)
`;

const nodeHog = `
const crypto = require("crypto");
const [target, chunk] = process.argv.slice(2).map(Number);
const held = [];
const start = performance.now();
const ms = () => Math.round(performance.now() - start);
let mib = 0;
while (mib < target) {
  let buf;
  try {
    buf = Buffer.allocUnsafeSlow(chunk << 20);
    crypto.randomFillSync(buf);
  } catch (error) {
    console.log("refused " + mib + " " + String((error && (error.code || error.message)) || error).replace(/\\s+/g, "_").slice(0, 80));
    process.exit(3);
  }
  held.push(buf);
  mib += chunk;
  console.log("held " + mib + " " + ms());
}
console.log("reached " + mib + " " + ms());
setTimeout(() => process.exit(0), 3000);
`;

const pythonHog = `
import os, sys, time
target, chunk = int(sys.argv[1]), int(sys.argv[2])
held = []
start = time.monotonic()
ms = lambda: int((time.monotonic() - start) * 1000)
mib = 0
while mib < target:
    try:
        buf = bytearray(chunk << 20)
        for offset in range(0, len(buf), 1 << 20):
            buf[offset:offset + (1 << 20)] = os.urandom(1 << 20)
    except MemoryError:
        print("refused", mib, "MemoryError", flush=True)
        sys.exit(3)
    held.append(buf)
    mib += chunk
    print("held", mib, ms(), flush=True)
print("reached", mib, ms(), flush=True)
time.sleep(3)
`;

export const guestScripts = {
  node: { state: nodeState, hog: nodeHog, extension: "js" },
  python3: { state: pythonState, hog: pythonHog, extension: "py" },
} as const satisfies {
  readonly [R in Runtime]: {
    readonly state: string;
    readonly hog: string;
    readonly extension: string;
  };
};

/** Prints `runtime=<name> <path>` for the first runtime the guest has, Node before Python. */
export const runtimeCommand = [
  `if command -v node >/dev/null 2>&1; then echo "runtime=node $(command -v node)";`,
  `elif command -v python3 >/dev/null 2>&1; then echo "runtime=python3 $(command -v python3)";`,
  `else echo runtime=none; fi`,
].join(" ");

export function parseRuntime(stdout: string): { runtime: Runtime; path: string } | null {
  const match = /^runtime=(node|python3) (\S+)$/m.exec(stdout);
  const runtime = runtimes.find((name) => name === match?.[1]);

  return runtime && match?.[2] ? { runtime, path: match[2] } : null;
}

/** Starts `command` detached from the exec (its own session where `setsid` exists), output to `log`. */
export function detached(command: string, log: string) {
  const tail = `nohup sh -c ${quote(command)} >>${quote(log)} 2>&1 </dev/null &`;

  return `if command -v setsid >/dev/null 2>&1; then setsid ${tail} else ${tail} fi`;
}

/** The kernel's boot id: a new one means the guest booted again. */
export const bootIdCommand = `cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown`;

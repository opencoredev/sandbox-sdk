/**
 * Small guest programs for state-survival and memory-pressure, in the two runtimes nearly every
 * sandbox image ships: Node first, Python 3 second. Each check uploads the one the guest has.
 *
 * `state` modes (argv after the script):
 * - `serve PORT PIDFILE NONCE`: holds 32 MiB of random bytes and a random token in memory, writes its
 *   pid to PIDFILE once listening on 127.0.0.1:PORT, and answers GET / with
 *   `{nonce, token, pid, digestAtStart, digestNow, upMs}`. A restarted server has a new token, and a
 *   server whose memory changed has `digestNow !== digestAtStart`.
 * - `probe PORT TIMEOUT_MS NONCE`: polls GET / until the server launched with NONCE answers; prints
 *   `{ok, ms, body}`. Any other listener on the port does not count.
 * - `restart PORT PIDFILE LOG TIMEOUT_MS`: SIGKILLs the server in PIDFILE only when that pid is
 *   running this script (anything else, a missing file or a non-positive pid is left alone), starts a
 *   new one in its own session with a fresh nonce, and prints `{ok, ms, body}` once that child answers;
 *   `ms` runs from the kill.
 *
 * `hog TARGET_MIB CHUNK_MIB`: allocates CHUNK_MIB at a time, fills each chunk with random bytes so
 * no compression or page merging can shrink it, and prints `held MIB MS` after each chunk,
 * `reached MIB MS` at the target (then holds 3 s and exits 0), or `refused MIB REASON` and exit 3
 * when the runtime's allocation fails, MIB being what it still held.
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

function serve(port, pidfile, nonce) {
  const buf = crypto.randomBytes(32 << 20);
  const digest = () => crypto.createHash("sha256").update(buf).digest("hex");
  const token = crypto.randomBytes(16).toString("hex");
  const digestAtStart = digest();
  const started = Date.now();
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ nonce, token, pid: process.pid, digestAtStart, digestNow: digest(), upMs: Date.now() - started }));
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

async function poll(port, start, timeoutMs, accept) {
  for (;;) {
    const body = await get(port, 250);
    const ms = Math.round((now() - start) * 10) / 10;
    if (body && accept(body)) return { ok: true, ms, body };
    if (now() - start > timeoutMs) return { ok: false, ms, body: null };
    await new Promise((r) => setTimeout(r, 5));
  }
}

function ours(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").includes(__filename); } catch { return false; }
}

async function main() {
  if (mode === "serve") return serve(Number(args[0]), args[1], args[2]);
  if (mode === "probe") {
    const nonce = args[2];
    return console.log(JSON.stringify(await poll(Number(args[0]), now(), Number(args[1]), (b) => b.nonce === nonce)));
  }
  if (mode === "restart") {
    const [port, pidfile, log, timeoutMs] = args;
    let old = -1;
    try { old = Number(fs.readFileSync(pidfile, "utf8").trim()); } catch {}
    const start = now();
    if (ours(old)) process.kill(old, "SIGKILL");
    const nonce = crypto.randomBytes(8).toString("hex");
    const out = fs.openSync(log, "a");
    const child = cp.spawn(process.execPath, [__filename, "serve", port, pidfile, nonce], { detached: true, stdio: ["ignore", out, out] });
    child.unref();
    const result = await poll(Number(port), start, Number(timeoutMs), (b) => b.nonce === nonce && b.pid === child.pid);
    return console.log(JSON.stringify(result));
  }
  process.exit(64);
}
main();
`;

const pythonState = `
import hashlib, http.server, json, os, secrets, signal, subprocess, sys, time, urllib.request

SELF = os.path.abspath(__file__)

def serve(port, pidfile, nonce):
    buf = bytearray(os.urandom(32 << 20))
    digest = lambda: hashlib.sha256(buf).hexdigest()
    token = secrets.token_hex(16)
    at_start = digest()
    started = time.time()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"nonce": nonce, "token": token, "pid": os.getpid(), "digestAtStart": at_start,
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

def poll(port, start, timeout_ms, accept):
    while True:
        body = get(port, 0.25)
        ms = round((time.monotonic() - start) * 1000, 1)
        if isinstance(body, dict) and accept(body):
            return {"ok": True, "ms": ms, "body": body}
        if ms > timeout_ms:
            return {"ok": False, "ms": ms, "body": None}
        time.sleep(0.005)

def ours(pid):
    if pid <= 1:
        return False
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            return SELF.encode() in f.read().split(b"\\0")
    except Exception:
        return False

mode, args = sys.argv[1], sys.argv[2:]
if mode == "serve":
    serve(int(args[0]), args[1], args[2])
elif mode == "probe":
    nonce = args[2]
    print(json.dumps(poll(int(args[0]), time.monotonic(), float(args[1]), lambda b: b.get("nonce") == nonce)))
elif mode == "restart":
    port, pidfile, log, timeout_ms = args
    try:
        old = int(open(pidfile).read().strip())
    except Exception:
        old = -1
    start = time.monotonic()
    if ours(old):
        os.kill(old, signal.SIGKILL)
    nonce = secrets.token_hex(8)
    out = open(log, "a")
    child = subprocess.Popen([sys.executable, SELF, "serve", port, pidfile, nonce], stdin=subprocess.DEVNULL,
                             stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    print(json.dumps(poll(int(port), start, float(timeout_ms), lambda b: b.get("nonce") == nonce and b.get("pid") == child.pid)))
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

/**
 * A shell function, `ownkill PIDFILE MARKER`: SIGKILLs the pid in PIDFILE only when it is a positive
 * number above 1 and its command line contains MARKER (this attempt's own directory), so a missing
 * file, a stale pid reused by another process, or a negative pid signals nothing.
 */
export const ownKillFunction = [
  `ownkill() {`,
  `  p=$(cat "$1" 2>/dev/null)`,
  `  case "$p" in ''|*[!0-9]*) return 0;; esac`,
  `  [ "$p" -gt 1 ] || return 0`,
  `  tr '\\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -qF -- "$2" || return 0`,
  `  kill -9 "$p" 2>/dev/null`,
  `  return 0`,
  `}`,
].join("\n");

/**
 * A shell function, `identity PIDFILE MARKER`: prints the pid's start time (field 22 of its stat)
 * when it is alive, owned as for `ownkill` and not a zombie; prints nothing otherwise.
 */
export const identityFunction = [
  `identity() {`,
  `  p=$(cat "$1" 2>/dev/null)`,
  `  case "$p" in ''|*[!0-9]*) return 0;; esac`,
  `  [ "$p" -gt 1 ] || return 0`,
  `  tr '\\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -qF -- "$2" || return 0`,
  `  s=$(sed 's/^.*) //' "/proc/$p/stat" 2>/dev/null)`,
  `  set -- $s`,
  `  [ "$1" = Z ] && return 0`,
  `  echo "$p:\${20}"`,
  `}`,
].join("\n");

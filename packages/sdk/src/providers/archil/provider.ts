/** Verified against disk 1.12.1, Archil's TypeScript SDK (https://github.com/archil-data/archil-sdk). */
import { createHash } from "node:crypto";
import type {
  Archil,
  ArchilOptions as ArchilClientOptions,
  CreateSandboxRequest,
  Sandbox,
  SandboxNetwork,
  SandboxStatus,
} from "disk";
import type {
  CreateInput,
  Labels,
  Provider,
  SandboxInfo,
  Terminal,
  TerminalOptions,
} from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { loadPeer } from "../../peer.js";
import { secretRecoveryCommand } from "../../run.js";
import { files, type Guest } from "../../shared/guest.js";
import { isObject, isString, isStringRecord } from "../../shared/narrow.js";
import { quote } from "../../shared/shell.js";
import { archilError, failure, isTransportMissing, nativeStatus, notRunning } from "./errors.js";
import {
  bounded,
  collect,
  collectExact,
  disconnect,
  execute,
  inDirectory,
  terminate,
  type ArchilProcess,
  type ArchilRunner,
} from "./execute.js";

export interface ArchilOptions {
  /** Defaults to ARCHIL_API_KEY. Keys are made per region in the Archil console. */
  apiKey?: string;
  /** The key's region, such as `aws-us-east-1` (the default) or `aws-eu-west-1`. Defaults to ARCHIL_REGION. */
  region?: string;
  /** Public OCI image for new sandboxes. Unset uses Archil's default, `node:24-bookworm`. */
  image?: string;
  /** A ready image ID from Archil's image builds, instead of `image`. */
  imageId?: string;
}

export interface ArchilNative {
  sandbox: Sandbox;
  client: Archil;
}

type ArchilCapability = "pause" | "terminal" | "network-policy" | "size";

export type ArchilProvider = Provider<ArchilNative, ArchilCapability>;

/** The `disk` module, or a test fixture with the same shape. */
export interface ArchilModule {
  Archil: new (options: ArchilClientOptions) => Archil;
}

const prefix = "sbxsdk-";

/**
 * The names this adapter gives sandboxes: `sbxsdk-<UUIDv4>`, or `sbxsdk-k<40 hex>` for a key. A
 * paused or stopped sandbox's marker cannot be read, so only a name in exactly this form counts
 * as the SDK's; a merely similar name, like `sbxsdk-native-test`, never does.
 */
const sdkName =
  /^sbxsdk-(?:k[0-9a-f]{40}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

// The label the core stamps on every sandbox it creates.
const sdkLabel: Labels = { "sandbox-sdk": "1" };

// The guest variable each create sets to its own attempt ID, and the command that prints it.
const attemptVariable = "SANDBOX_SDK_ATTEMPT";
const readAttempt = `printf '%s' "$SANDBOX_SDK_ATTEMPT"`;

// Archil's longest lifetime, its default: a sandbox with no timeoutMs gets this.
const archilMaxLifetimeSeconds = 86_400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// How long create waits for a sandbox to run, and a keyed lookup for its creator's marker.
const readyTimeoutMs = 180_000;
const markerWaitMs = 60_000;

/** A keyed sandbox's native name. Archil names are unique per account, so the key is exact. */
function keyedName(key: string) {
  return `${prefix}k${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

const presets = {
  small: { cpu: 1, memoryMb: 2048 },
  medium: { cpu: 2, memoryMb: 4096 },
  large: { cpu: 4, memoryMb: 8192 },
} as const;

function machineFor(
  size: CreateInput["size"],
): Pick<CreateSandboxRequest, "vcpuCount" | "memSizeMiB"> {
  if (size === undefined) return {};
  const value = isString(size) ? presets[size] : size;

  if (!isString(size) && size.diskGb !== undefined)
    throw failure("Archil sandboxes have no disk size option", "unsupported");

  if (!Number.isInteger(value.cpu) || value.cpu < 1 || value.cpu > 32)
    throw failure("Archil sandboxes take 1 to 32 whole vCPUs", "unsupported");

  if (!Number.isInteger(value.memoryMb) || value.memoryMb < 256 || value.memoryMb > 65_536)
    throw failure("Archil sandboxes take 256 to 65536 MiB of memory, in whole MiB", "unsupported");

  return { vcpuCount: value.cpu, memSizeMiB: value.memoryMb };
}

/**
 * Archil lifetimes are whole seconds, 60 s to 24 h, and expiry pauses the sandbox. Traffic to a public
 * port resumes a paused sandbox with a fresh lifetime, so a hard `timeoutMs` holds only with no port.
 */
function lifetimeFor(timeoutMs: number | undefined, ports: readonly number[] | undefined) {
  if (timeoutMs === undefined) return undefined;

  if (ports?.length)
    throw failure(
      "Archil resumes a paused sandbox on traffic to an exposed port, so timeoutMs can't be a hard limit with ports",
      "unsupported",
    );

  // Rounded down, so the hard limit is never longer than asked, and at most a second under 24 hours,
  // so a sandbox with a lifetime is always told apart from one without (Archil's default is 24 h).
  const seconds = Math.min(Math.floor(timeoutMs / 1000), archilMaxLifetimeSeconds - 1);

  if (timeoutMs < 60_000 || timeoutMs > archilMaxLifetimeSeconds * 1000)
    throw failure("Archil sandbox lifetimes are 60 seconds to 24 hours", "unsupported");

  return seconds;
}

function idleFor(idleTimeoutMs: number | undefined) {
  if (idleTimeoutMs === undefined) return undefined;
  const seconds = Math.ceil(idleTimeoutMs / 1000);

  if (seconds < 1 || seconds > 86_400)
    throw failure("Archil idle timeouts are 1 second to 24 hours", "unsupported");

  return seconds;
}

function networkFor(network: CreateInput["network"]): SandboxNetwork | undefined {
  if (network === undefined) return undefined;

  if (network === "all") return { egress: { default: "allow" } };

  if (network === "none") return { egress: { default: "deny" } };

  return { egress: { default: "deny", allow: [...network.allow] } };
}

// States that still hold a sandbox. failed, deleting and deleted do not.
function stateOf(status: SandboxStatus): SandboxInfo["state"] | undefined {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "pausing":
    case "paused":
      return "paused";
    case "stopping":
    case "stopped":
    case "exited":
    // A sandbox that failed at runtime still holds its name and disk: it is reachable (connect, destroy)
    // but never woken or adopted by a keyed lookup, which reports it instead.
    case "failed":
      return "stopped";
    case "deleting":
    case "deleted":
      return undefined;
    default: {
      const _exhaustive: never = status;

      return undefined;
    }
  }
}

/**
 * Archil keeps no labels on a sandbox, so the adapter writes them into its root disk at create:
 * `{ key, labels, createdAt }`. The disk persists across pause and stop, but a file can only be
 * read while the sandbox runs.
 */
const markerPath = "/var/lib/sandbox-sdk/metadata.json";

// Where the core records secret names (src/handle.ts).
const secretNamesPath = "/tmp/.sandbox-sdk/secret-names.json";

// Makes the default working directory, then publishes the marker atomically, in one process. The
// marker is last: a keyed lookup that sees it knows setup finished.
// The core's secret-names record goes first: a client that sees the marker can always recover them.
const setupCommand = `mkdir -p /workspace /var/lib/sandbox-sdk /tmp/.sandbox-sdk && printf '%s' "$SANDBOX_SDK_SECRET_NAMES" > ${secretNamesPath}.tmp && mv -f ${secretNamesPath}.tmp ${secretNamesPath} && printf '%s' "$SANDBOX_SDK_MARKER" > ${markerPath}.tmp && mv -f ${markerPath}.tmp ${markerPath}`;

interface Marker {
  key?: string;
  labels: Labels;
}

function parseMarker(bytes: Uint8Array): Marker | undefined {
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }

  if (!isObject(value) || !("labels" in value) || !isStringRecord(value.labels)) return undefined;
  const key = "key" in value && isString(value.key) ? value.key : undefined;

  return { key, labels: { ...value.labels } };
}

function matches(info: SandboxInfo, labels: Labels) {
  return Object.entries(labels).every(([key, value]) => info.labels[key] === value);
}

// Writes stdin to the path in $SANDBOX_SDK_PATH (bytes, exactly as given), with argv[1] as an octal
// mode or "" to keep an existing file's mode (644 for a new file), making its directory first.
// The parent is resolved first, then the leaf: a leaf symlink is followed one hop at a time to its
// final target (a loop exits 22), each hop's parent resolved again. A parent is walked one
// component at a time as the kernel walks it: a linked directory is followed
// before a later `..` (`link/../x` lands where the kernel puts it), a missing directory is created,
// even as a dangling link's target (`config -> storage/generated`), and a regular file used as a
// directory exits 24 (`file/../x` is refused, as the kernel refuses it).
// An existing directory exits 21 and any other non-regular file (a FIFO, a device) exits 23, both
// checked again once stdin is staged, so a change mid-write is caught too. stdin is staged beside
// the target and renamed over it only once complete, so a failed write (a full disk, a broken
// stream) leaves the old file whole. A file with other hard links is copied over in place once
// fully staged, so its links keep sharing it; only a failure during that copy can leave it partial.
const writeSource = [
  "import os,sys,stat,tempfile",
  "def no(code,why):",
  " sys.stderr.write(why+'\\n'); sys.exit(code)",
  "def check(p):",
  " try: st=os.stat(p)",
  " except FileNotFoundError: return None",
  " if stat.S_ISDIR(st.st_mode): no(21,'is a directory')",
  " if not stat.S_ISREG(st.st_mode): no(23,'not a regular file')",
  " return st",
  "p=os.environb[b'SANDBOX_SDK_PATH']",
  "m=sys.argv[1]",
  "def walk(d):",
  " out=b'/' if d.startswith(b'/') else os.getcwdb()",
  " todo=[c for c in d.split(b'/') if c and c!=b'.']",
  " hops=0",
  " while todo:",
  "  c=todo.pop(0)",
  "  if c==b'..': out=os.path.dirname(out); continue",
  "  nxt=os.path.join(out,c)",
  "  if os.path.islink(nxt):",
  "   hops+=1",
  "   if hops>40: no(22,'too many levels of symbolic links')",
  "   t=os.readlink(nxt)",
  "   if t.startswith(b'/'): out=b'/'",
  "   todo=[x for x in t.split(b'/') if x and x!=b'.']+todo",
  "   continue",
  "  if not os.path.lexists(nxt):",
  "   try: os.mkdir(nxt)",
  "   except FileExistsError: todo.insert(0,c); continue",
  "  elif not os.path.isdir(nxt): no(24,'a parent is not a directory')",
  "  out=nxt",
  " return out",
  "n=0",
  "while True:",
  " if not os.path.basename(p): no(21,'is a directory')",
  " d=walk(os.path.dirname(p))",
  " p=os.path.join(d,os.path.basename(p))",
  " if not os.path.islink(p): break",
  " n+=1",
  " if n>40: no(22,'too many levels of symbolic links')",
  " p=os.path.join(d,os.readlink(p))",
  "check(p)",
  "fd,t=tempfile.mkstemp(dir=d,prefix=b'.sandbox-sdk-write.')",
  "try:",
  " with os.fdopen(fd,'wb') as f:",
  "  while True:",
  "   b=sys.stdin.buffer.read(1048576)",
  "   if not b: break",
  "   f.write(b)",
  " st=check(p)",
  " if st is not None and st.st_nlink>1:",
  "  try:",
  "   with open(t,'rb') as s, open(p,'wb') as f:",
  "    while True:",
  "     b=s.read(1048576)",
  "     if not b: break",
  "     f.write(b)",
  "  except IsADirectoryError: no(21,'is a directory')",
  "  if m: os.chmod(p,int(m,8))",
  " else:",
  "  os.chmod(t,int(m,8) if m else stat.S_IMODE(st.st_mode) if st else 0o644)",
  "  try: os.rename(t,p)",
  "  except IsADirectoryError: no(21,'is a directory')",
  "finally:",
  " if os.path.lexists(t): os.unlink(t)",
].join("\n");

// Isolated (-I): the guest's working directory, PYTHON* variables and user site can't shadow the
// standard library these helpers import.
const isolatedPython = (code: string, ...args: string[]) =>
  `python3 -I -S -c ${quote(code)} ${args.map(quote).join(" ")}`;

const writeProgram = (mode: number | undefined) =>
  isolatedPython(writeSource, mode === undefined ? "" : mode.toString(8));

// Prints argv[3] bytes of regular file argv[1] from offset argv[2] (-1: to the end); exit 3 if absent.
const readProgram =
  "import os,sys\np=sys.argv[1]\nif not os.path.isfile(p): sys.exit(3)\nwith open(p,'rb') as f:\n f.seek(int(sys.argv[2]))\n n=int(sys.argv[3])\n o=sys.stdout.buffer\n while n!=0:\n  b=f.read(1048576 if n<0 else min(n,1048576))\n  if not b: break\n  o.write(b)\n  if n>0: n-=len(b)";

/** @internal The adapter behind `archil()`. `load` imports `disk`; tests pass a fixture. */
export function createArchilProvider(
  options: ArchilOptions,
  load: () => Promise<ArchilModule>,
): ArchilProvider {
  let client: Promise<Archil> | undefined;
  let current: Archil | undefined;
  const boxes = new Map<string, Sandbox>();
  // Terminal connections this client opened, per sandbox, so close and destroy can drop them.
  const terminals = new Map<string, Set<ArchilProcess>>();

  async function connectClient(): Promise<Archil> {
    const apiKey = options.apiKey ?? process.env.ARCHIL_API_KEY;

    if (!apiKey?.trim())
      throw failure(
        "Archil API key is missing. Authentication is required. Set ARCHIL_API_KEY or pass apiKey.",
        "auth",
      );
    const region = options.region ?? process.env.ARCHIL_REGION ?? "aws-us-east-1";
    const { Archil } = await loadPeer("disk", "archil", load);

    return (current = new Archil({ apiKey: apiKey.trim(), region }));
  }

  /** One client per provider. A failed setup (no key, no peer) is retried on the next call. */
  async function api(): Promise<Archil> {
    client ??= connectClient();

    try {
      return await client;
    } catch (error) {
      client = undefined;
      throw error;
    }
  }

  async function safe<T>(id: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw archilError(error, id);
    }
  }

  /** The sandbox, fetched once per client. Not this SDK's, or gone: not_found. */
  async function sandbox(id: string): Promise<Sandbox> {
    const known = boxes.get(id);

    if (known) return known;
    let value: Sandbox;

    try {
      value = await (await api()).sandboxes.get(id);
    } catch (error) {
      // A malformed ID is a 400 from Archil; for connect it is simply not a sandbox here.
      if ([400, 404].includes(nativeStatus(error) ?? 0))
        throw failure("Sandbox not found", "not_found", id);
      throw error;
    }

    if (!sdkName.test(value.name) || stateOf(value.status) === undefined)
      throw failure("Sandbox not found", "not_found", id);
    boxes.set(id, value);

    return value;
  }

  /**
   * Waits out a transition (pending, pausing, stopping), then brings a paused or stopped sandbox
   * back so it can run commands. Archil refuses a resume while it is still pausing.
   */
  /** Brings the sandbox to running. True when this call resumed or started it, false when it already ran. */
  async function wake(box: Sandbox): Promise<boolean> {
    const deadline = Date.now() + readyTimeoutMs;
    await box.refresh();

    while (["pending", "pausing", "stopping"].includes(box.status)) {
      if (Date.now() > deadline)
        throw failure(`Sandbox stayed ${box.status} too long`, "timeout", box.id);
      await sleep(250);
      await box.refresh();
    }

    let woke = false;

    try {
      if (box.status === "paused") {
        await box.resume();
        woke = true;
      } else if (box.status === "stopped" || box.status === "exited") {
        await box.start();
        woke = true;
      }
    } catch (error) {
      // Refused because another client woke it first: running now, and not this call's doing.
      if (!notRunning(error)) throw error;
      await box.refresh();

      if (box.status !== "running") throw error;
    }

    // Deleted meanwhile: gone, so a keyed lookup can create a replacement.
    if (stateOf(box.status) === undefined) throw failure("Sandbox not found", "not_found", box.id);

    // A sandbox that failed while settling, or whose resume or start answered failed, isn't awake.
    // resume and start apply Archil's answer to `box`, so this needs no further request.
    if (box.status !== "running")
      throw failure(
        `Sandbox ${box.id} is ${box.status} on Archil, not running; destroy it and create another`,
        "unavailable",
        box.id,
      );

    return woke;
  }

  /**
   * A runner for the sandbox. A paused or stopped sandbox is refused with a resume hint, never woken.
   */
  function runner(id: string): ArchilRunner {
    return {
      run: async (command, runOptions) => {
        const box = await sandbox(id);

        try {
          return await box.run(command, runOptions);
        } catch (error) {
          if (!notRunning(error)) throw error;

          // Never woken implicitly: a wake from an internal check (reaping, listing) would undo
          // Archil's own idle pause. The caller decides.
          throw failure(
            "Sandbox is paused or stopped (Archil pauses an idle sandbox after idleTimeoutMs, 30 minutes by default). Call box.resume() first",
            "unavailable",
            id,
          );
        }
      },
    };
  }

  function guest(id: string): Guest {
    const run = runner(id);

    return {
      name: "archil",
      raw: async (command) => {
        const result = await collectExact(run, id, command);

        if (result.exitCode !== 0) throw failure("Guest operation failed", "provider", id);

        return new TextDecoder().decode(result.stdout);
      },
      upload: async (path, bytes, mode) => {
        const result = await collect(run, id, writeProgram(mode), {
          env: { SANDBOX_SDK_PATH: path },
          stdin: bytes,
        });

        if (result.exitCode === 21) throw failure("Path is a directory", "invalid_argument", id);

        if (result.exitCode === 22) throw failure("Path is a symlink loop", "invalid_argument", id);

        if (result.exitCode === 23)
          throw failure("Path is not a regular file", "invalid_argument", id);

        if (result.exitCode === 24)
          throw failure("A parent of the path is not a directory", "invalid_argument", id);

        if (result.exitCode !== 0) throw failure("File write failed", "provider", id);
      },
      read: async (path, range) => {
        // A range is usually a small log page: one helper read, unless Archil's stream skipped bytes.
        if (range) {
          const result = await collect(
            run,
            id,
            isolatedPython(readProgram, path, String(range.offset), String(range.length)),
          );

          if (result.exitCode === 3) throw failure("File does not exist", "file_not_found", id);

          if (result.exitCode !== 0) throw failure("File read failed", "provider", id);

          if (result.lost === 0) return result.stdout;
        }

        const whole = await download(id, path);

        return range ? whole.subarray(range.offset, range.offset + range.length) : whole;
      },
    };
  }

  /**
   * Reads a whole file through `disk`'s download, which asks for one 512 KiB piece at a time and so
   * never outruns Archil's output stream. Its failures carry guest text, so a stat classifies them.
   */
  async function download(id: string, path: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];

    const attempt = async () => {
      parts.length = 0;
      await (
        await sandbox(id)
      ).files.downloadFile(path, (chunk) => {
        parts.push(chunk.slice());
      });
    };

    try {
      await attempt();
    } catch {
      // Missing, not a regular file, or the sandbox paused itself: the stat wakes it if so.
      const check = await collect(runner(id), id, `[ -f ${quote(path)} ]`);

      if (check.exitCode !== 0) throw failure("File does not exist", "file_not_found", id);

      try {
        await attempt();
      } catch {
        throw failure("File read failed", "provider", id);
      }
    }

    const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;

    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }

    return bytes;
  }

  /** Reads a running sandbox's marker. Undefined when it has none: not made by this SDK, or still being made. */
  async function markerOf(id: string): Promise<Marker | undefined> {
    const result = await collectExact(runner(id), id, `cat -- ${quote(markerPath)}`, {
      timeoutMs: 30_000,
    });

    return result.exitCode === 0 ? parseMarker(result.stdout) : undefined;
  }

  /**
   * A sandbox as SandboxInfo. A running one reports the key and labels in its marker; a paused or
   * stopped one cannot be read without waking it, so `readable` is false and its labels are empty.
   */
  async function infoOf(
    box: Sandbox,
  ): Promise<{ info: SandboxInfo; readable: boolean } | undefined> {
    const state = stateOf(box.status);

    if (!sdkName.test(box.name) || state === undefined) return undefined;
    const base = { id: box.id, state, createdAt: box.createdAt.getTime() };

    // The SDK's name format stands in for the core's own label; the rest waits until it runs again.
    if (state !== "running") return { info: { ...base, labels: { ...sdkLabel } }, readable: false };
    boxes.set(box.id, box);
    let marker: Marker | undefined;

    try {
      marker = await markerOf(box.id);
    } catch (error) {
      // It went to sleep during the read (refused at start, or its stream cut by the pause): report
      // it asleep and unread, as if listed that way. A sandbox that still runs is a failed read,
      // never a keyless sandbox.
      if (!(error instanceof SandboxError)) throw error;
      await box.refresh();
      const now = stateOf(box.status);

      if (now === undefined) return undefined;

      if (now === "running") throw error;

      return { info: { ...base, state: now, labels: { ...sdkLabel } }, readable: false };
    }

    if (!marker) return undefined;

    return { info: { ...base, key: marker.key, labels: marker.labels }, readable: true };
  }

  /**
   * Deletes a sandbox, stopping it first. "gone" once it is; "late" when the deadline passed before
   * a delete was sent (the sandbox stays); "unconfirmed" when a delete was in flight at the deadline
   * (Archil's client may still retry it, so it may yet be deleted).
   */
  async function remove(c: Archil, id: string): Promise<"gone" | "late" | "unconfirmed"> {
    const deadline = Date.now() + 120_000;

    // Every request is bounded by what is left of the deadline, and none starts after it.
    const within = async <T>(action: () => Promise<T>): Promise<T | "late"> =>
      Date.now() >= deadline ? "late" : bounded(action(), deadline - Date.now());

    for (;;) {
      let box: Sandbox | "late";

      try {
        box = await within(() => c.sandboxes.get(id));
      } catch (error) {
        if ([400, 404].includes(nativeStatus(error) ?? 0)) return "gone";
        throw error;
      }

      if (box === "late") return "late";

      if (box.status === "deleting" || box.status === "deleted") return "gone";

      try {
        // A non-waiting stop, polled below under the deadline: a sandbox stuck stopping can't hang it.
        if (!["stopped", "exited", "failed", "stopping"].includes(box.status))
          if ((await within(() => box.stop({ wait: false }))) === "late") return "late";

        if (["stopped", "exited", "failed"].includes(box.status)) {
          // Not sent at all: the sandbox stays. Sent but unanswered: it may still be deleted. One
          // reading of the clock both decides to send and bounds the wait.
          const left = deadline - Date.now();

          if (left <= 0) return "late";

          if ((await bounded(box.delete(), left)) === "late") return "unconfirmed";

          return "gone";
        }
      } catch (error) {
        if (nativeStatus(error) === 404) return "gone";

        // 409 while a pause, resume or start is still settling.
        if (nativeStatus(error) !== 409) throw error;
      }

      if (Date.now() >= deadline) return "late";

      await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    }
  }

  /** Disconnects every terminal this client opened on the sandbox. */
  async function detachTerminals(id: string) {
    const open = terminals.get(id);
    terminals.delete(id);

    if (open) await Promise.all([...open].map((process) => disconnect(process)));
  }

  async function terminal(id: string, terminalOptions: TerminalOptions): Promise<Terminal> {
    const listeners = new Set<(data: string) => void>();
    const decoder = new TextDecoder();

    const process = await runner(id).run(
      inDirectory(terminalOptions.cwd ?? "/workspace", "exec /bin/bash -l || exec /bin/sh"),
      {
        env: { TERM: "xterm-256color", ...terminalOptions.env },
        terminal: { cols: terminalOptions.cols, rows: terminalOptions.rows },
        collectOutput: false,
        onOutput: ({ data }) => {
          const text = decoder.decode(data, { stream: true });

          if (text) for (const listener of listeners) listener(text);
        },
      },
    );

    // Observed at once, so a stream that drops before anyone waits is not an unhandled rejection.
    let open = terminals.get(id);

    if (!open) {
      open = new Set();
      terminals.set(id, open);
    }

    open.add(process);

    // Once the shell ends, its connection leaves the registry, so ended sessions don't pile up.
    const ended = process.wait();

    const forget = () => {
      const set = terminals.get(id);
      set?.delete(process);

      if (set?.size === 0) terminals.delete(id);
      void disconnect(process);
    };

    ended.then(forget, forget);

    return {
      write: (data) => safe(id, () => process.sendInput(data)),
      resize: (cols, rows) => safe(id, () => process.resize({ cols, rows })),
      onData(callback) {
        listeners.add(callback);

        return () => listeners.delete(callback);
      },
      close: () =>
        safe(id, async () => {
          try {
            if (!(await terminate(process)))
              throw failure("Terminal could not be closed", "outcome_unknown", id);
          } finally {
            terminals.get(id)?.delete(process);
            await disconnect(process);
          }
        }),
      wait: () =>
        safe(id, async () => {
          const result = await ended;

          return { exitCode: result.status === "completed" ? (result.exitCode ?? null) : null };
        }),
    };
  }

  const provider: ArchilProvider = {
    name: "archil",
    keyMode: "exact",
    // One VM per sandbox: every process runs as root in one PID namespace with /proc mounted.
    procActivity: true,
    // Setup writes the secret-names record before the marker, so the core leaves it alone.
    recordsSecretNames: true,
    // Key and labels live in a file inside the sandbox, readable only while it runs.
    readsMetadataOnlyWhenRunning: true,
    // Archil's output stream can skip bytes, so the secret names and environment are read through
    // a check that refuses any gap: a lost value would otherwise switch its redaction off.
    readSecretEnvironment: (id) =>
      safe(id, async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await collect(runner(id), id, secretRecoveryCommand, {
            timeoutMs: 30_000,
          });

          if (result.exitCode !== 0) throw failure("Secret recovery failed", "provider", id);

          if (result.lost > 0) continue;
          const wire = new TextDecoder().decode(result.stdout);

          if (!wire) return undefined;
          const separator = wire.indexOf("\0");

          if (separator < 0) throw failure("Secret recovery record is malformed", "provider", id);
          const environment: Record<string, string> = {};

          for (const entry of wire.slice(separator + 1).split("\0")) {
            const equal = entry.indexOf("=");

            if (equal >= 0) environment[entry.slice(0, equal)] = entry.slice(equal + 1);
          }

          return { record: wire.slice(0, separator), environment };
        }

        throw failure("Secret recovery output was incomplete three times", "unavailable", id);
      }),
    capabilities: new Set<ArchilCapability>(["pause", "terminal", "network-policy", "size"]),
    create: (input) =>
      safe(undefined, async () => {
        if (input.from !== undefined)
          throw failure("Archil adapter has no snapshot restore", "unsupported");

        const attempt = crypto.randomUUID();

        const request: CreateSandboxRequest = {
          name: input.key === undefined ? `${prefix}${crypto.randomUUID()}` : keyedName(input.key),
          ...machineFor(input.size),
          ...(options.imageId === undefined
            ? options.image === undefined
              ? {}
              : { baseImage: options.image }
            : { imageId: options.imageId }),
          // Each create's own ID, readable in the guest: proof of which create made a keyed sandbox.
          env: { ...input.env, [attemptVariable]: attempt },
          network: networkFor(input.network),
          ports: input.ports?.length ? [...input.ports] : undefined,
          maxTtlSeconds: lifetimeFor(input.timeoutMs, input.ports),
          idleTtlSeconds: idleFor(input.idleTimeoutMs),
        };

        if (input.signal?.aborted) throw failure("Creation aborted", "aborted");
        const c = await api();

        const unknown = () =>
          failure(
            `Sandbox creation outcome is unknown; delete sandbox ${request.name ?? ""} if it exists before retrying`,
            "outcome_unknown",
          );

        let box: Sandbox;
        let adopted = false;

        try {
          // Allocate without waiting, so the ID is held before anything else can fail.
          box = await c.sandboxes.create(request, { wait: false });
        } catch (error) {
          const status = nativeStatus(error);

          // A 4xx refusal made nothing (a name conflict included: the core looks the key up again),
          // and neither did a transport that never loaded.
          if ((status !== undefined && status < 500) || isTransportMissing(error)) throw error;

          // No answer, or a 5xx: the create may have landed. The name is this attempt's alone
          // unless keyed; absence right after is not proof, so it stays unknown.
          const found = await c.sandboxes
            .list()
            .then((all) => all.find((native) => native.name === request.name))
            .catch(() => undefined);

          if (!found) throw unknown();
          box = found;
          // A keyed name may belong to another client's create: adopt it only once its attempt ID
          // proves it is this one, and never delete it before then.
          adopted = input.key !== undefined;
        }

        const marker = JSON.stringify({ key: input.key, labels: input.labels } satisfies Marker);

        try {
          const deadline = Date.now() + readyTimeoutMs;

          while (box.status === "pending") {
            if (input.signal?.aborted) throw failure("Creation aborted", "aborted", box.id);

            if (Date.now() > deadline)
              throw failure("Sandbox did not start in time", "timeout", box.id);
            await sleep(250);
            await box.refresh();
          }

          if (box.status !== "running")
            throw failure(`Sandbox did not start (${box.status})`, "provider", box.id);
          boxes.set(box.id, box);

          if (adopted) {
            const seen = await collectExact(runner(box.id), box.id, readAttempt, {
              timeoutMs: 30_000,
            }).catch(() => undefined);

            if (seen === undefined || seen.exitCode !== 0) throw unknown();

            // Another client's create holds the name: the core looks the key up and finds theirs.
            if (new TextDecoder().decode(seen.stdout) !== attempt)
              throw failure("Another client created this keyed sandbox first", "provider", box.id);
            adopted = false;
          }

          const prepared = await collect(runner(box.id), box.id, setupCommand, {
            env: {
              SANDBOX_SDK_MARKER: marker,
              SANDBOX_SDK_SECRET_NAMES: JSON.stringify(input.secretNames ?? []),
            },
          });

          if (prepared.exitCode !== 0) throw failure("Sandbox setup failed", "provider", box.id);

          return {
            id: box.id,
            key: input.key,
            labels: { ...input.labels },
            state: "running",
            createdAt: box.createdAt.getTime(),
          };
        } catch (error) {
          boxes.delete(box.id);

          // Not proven to be this create's (it never ran, failed to boot, or the caller gave up):
          // another client's create may own it, so it is never deleted here. Name it so the
          // caller can reconcile.
          if (adopted)
            throw failure(
              `Sandbox creation outcome is unknown; sandbox ${box.id} may be this create's; delete it if no other client uses this key`,
              "outcome_unknown",
              box.id,
            );

          // The sandbox exists and is billed: settle the failure only once it is gone.
          const cleaned = await remove(c, box.id).catch(() => "late" as const);

          if (cleaned !== "gone")
            throw failure(
              `Sandbox ${box.id} did not become usable and could not be deleted; delete it before retrying`,
              "outcome_unknown",
              box.id,
            );
          throw archilError(error, box.id);
        }
      }),
    find: (key) =>
      safe(undefined, async () => {
        const name = keyedName(key);
        // One deadline covers every native call, so no single stalled request outlasts it.
        const deadline = Date.now() + readyTimeoutMs + markerWaitMs;

        const late = (id?: string) =>
          failure("Keyed sandbox is still being set up by another client", "timeout", id);

        const within = async <T>(action: Promise<T>, id?: string): Promise<T> => {
          const result = await bounded(action, Math.max(0, deadline - Date.now()));

          if (result === "late") throw late(id);

          return result;
        };

        const c = await api();
        const box = (await within(c.sandboxes.list())).find((native) => native.name === name);

        if (!box) return undefined;
        boxes.set(box.id, box);

        const gone = () => {
          boxes.delete(box.id);

          return undefined;
        };

        // A stopped or paused sandbox is started or resumed: only a running one can show the marker
        // that proves it is this key's. A pending or running one without it is still being set up
        // by its creator, who deletes it if setup fails: wait for the marker, or for it to go.
        // What a wake changed, so a sandbox that proves to be someone else's is put back.
        let woke: "paused" | "stopped" | undefined;
        let woken = false;

        // At most one restore runs, however many exits ask for it. It waits for a wake still in flight
        // to land first, so a slow resume can't arrive after it; callers wait at most 30 s for it.
        let pendingWake: Promise<boolean> | undefined;
        let restoring: Promise<void> | undefined;

        // Only a state change this lookup made is undone, and only once the marker proves the sandbox
        // belongs to another key: a wake that was refused, or found it already running, leaves it alone.
        const restore = () => {
          restoring ??= (async () => {
            const changed = await pendingWake?.catch(() => false);

            if (!changed) return;

            if (woke === "paused") await box.pause().catch(() => {});
            else if (woke === "stopped") await box.stop().catch(() => {});
          })();

          return bounded(restoring, 30_000);
        };

        for (;;) {
          if (stateOf(box.status) === undefined) return gone();

          // Its name stays taken, and its marker can't be read: say so, so the caller can destroy it.
          if (box.status === "failed")
            throw failure(
              `Sandbox ${box.id} under this key failed on Archil; destroy it (connectSandbox(provider, id).destroy()) and retry`,
              "unavailable",
              box.id,
            );

          try {
            if (box.status !== "running" && box.status !== "pending" && !woken) {
              woken = true;
              woke = box.status === "paused" || box.status === "pausing" ? "paused" : "stopped";
              pendingWake = wake(box);

              // A wake that outlasts the deadline is surfaced, not undone: another client may be
              // reopening the same sandbox, and pausing it under them would break their handle.
              await within(pendingWake, box.id);

              continue;
            }

            if (box.status === "running") {
              const marker = await within(
                markerOf(box.id).catch(() => undefined),
                box.id,
              );

              // A marker for another key means the name is not this key's sandbox.
              if (marker && marker.key !== key) {
                await restore();

                return gone();
              }

              if (marker)
                return {
                  id: box.id,
                  key,
                  labels: marker.labels,
                  state: "running",
                  createdAt: box.createdAt.getTime(),
                };
            }

            // Still unproven at the deadline: surfaced and left running, for the same reason.
            if (Date.now() > deadline) throw late(box.id);

            await sleep(500);
            await within(box.refresh(), box.id);
          } catch (error) {
            // Deleted meanwhile: the creator's setup failed, so the key is free again.
            if (nativeStatus(error) === 404) return gone();

            if (error instanceof SandboxError && error.code === "not_found") return gone();
            // Unproven either way: the only rollback is for a marker that proves another key.
            throw error;
          }
        }
      }),
    connect: (id) =>
      safe(id, async () => {
        boxes.delete(id);
        // A paused or stopped sandbox is reported as it is, without its key and labels, and not
        // woken: the core reopens a keyed one through find (readsMetadataOnlyWhenRunning).
        const found = await infoOf(await sandbox(id));

        if (!found) throw failure("Sandbox not found", "not_found", id);

        return found.info;
      }),
    list: (labels) =>
      safe(undefined, async () => {
        const result: SandboxInfo[] = [];

        const candidates = (await (await api()).sandboxes.list()).filter(
          (box) => sdkName.test(box.name) && stateOf(box.status) !== undefined,
        );

        // Eight marker reads at a time.
        for (let i = 0; i < candidates.length; i += 8) {
          const infos = await Promise.all(
            candidates.slice(i, i + 8).map((box) => infoOf(box).catch(() => undefined)),
          );

          // A paused or stopped sandbox cannot prove it is this SDK's without waking it, and a name
          // alone proves nothing, so it is left out: reaping never deletes one it cannot verify.
          for (const found of infos)
            if (found?.readable && matches(found.info, labels)) result.push(found.info);
        }

        return result;
      }),
    destroy: (id) =>
      safe(id, async () => {
        const c = await api();
        boxes.delete(id);
        await detachTerminals(id);

        const removed = await remove(c, id);

        if (removed === "late")
          throw failure(
            "Sandbox was not stopped and deleted within 2 minutes; it still exists, destroy it again",
            "timeout",
            id,
          );

        // Archil's client may still retry a delete after the deadline, so the outcome is unknown.
        if (removed === "unconfirmed")
          throw failure(
            "Sandbox deletion was not confirmed within 2 minutes; it may still complete",
            "outcome_unknown",
            id,
          );
      }),
    async close(id) {
      boxes.delete(id);
      // A closed handle keeps no connection: its terminals detach, and the shells keep running.
      await detachTerminals(id);
    },
    exec: (id, input) => safe(id, () => execute({ runner: runner(id), sandboxId: id, input })),
    files: { ...files(async (id) => guest(id), safe), writeSupportsMode: true },
    previewUrl: (id, port) =>
      safe(id, async () => {
        const box = await sandbox(id);

        // A public port would let traffic resume the sandbox past its lifetime, a fresh session each time.
        if (box.maxTtlSeconds < archilMaxLifetimeSeconds)
          throw failure(
            "This sandbox has a timeoutMs lifetime, and Archil resumes a paused sandbox on traffic to an exposed port. Create it without timeoutMs to use previews",
            "unsupported",
            id,
          );

        return { url: `https://${await box.exposePort(port)}` };
      }),
    pause: (id) =>
      safe(id, async () => {
        await (await sandbox(id)).pause();
      }),
    resume: (id) =>
      safe(id, async () => {
        const box = await sandbox(id);
        await box.refresh();

        // A sandbox that failed at runtime can't be resumed here: say so rather than report success.
        if (box.status === "failed")
          throw failure(
            `Sandbox ${id} failed on Archil and can't be resumed; destroy it and create another`,
            "unavailable",
            id,
          );

        // Archil refuses a resume while the pause is still settling.
        await wake(box);
      }),
    terminal: (id, terminalOptions) => safe(id, () => terminal(id, terminalOptions)),
    native(id) {
      const box = boxes.get(id);

      if (!box) throw failure("Connect the sandbox first", "not_found", id);

      if (!current) throw failure("Client is detached", "not_found", id);

      return { sandbox: box, client: current };
    },
  };

  return provider;
}

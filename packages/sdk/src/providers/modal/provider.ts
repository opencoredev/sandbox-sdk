import { createHash } from "node:crypto";
import type { SandboxCreateParams, SandboxRuntime } from "modal";
import type {
  CreateInput,
  ExecInput,
  ExecResult,
  FileInfo,
  Labels,
  Provider,
  SandboxInfo,
  TemplateBuildOptions,
  TemplateInfo,
  TemplateSpec,
} from "../../provider.js";
import { SandboxError, type ErrorCode } from "../../errors.js";
import { invalid, modalError, unsupported } from "./errors.js";
import type {
  ModalClientSlice,
  NativeApp,
  NativeFilesystem,
  NativeImage,
  NativeSandbox,
} from "./transport.js";

export type ModalCapability =
  | "snapshot"
  | "snapshot-delete"
  | "templates"
  | "network-policy"
  | "size";

/** Modal's own CPU and memory requests and limits. CPU is in Modal's `cpu` units (one unit runs one thread). */
export type ModalResources = Pick<
  SandboxCreateParams,
  "cpu" | "cpuLimit" | "memoryMiB" | "memoryLimitMiB"
>;

/** One destroy, timed from the terminate request. */
export interface ModalDestroyEvent {
  sandboxId: string;
  /** Until Modal accepted the terminate request. */
  requestMs: number;
  /** Until Modal reported the sandbox stopped; `null` when it did not within `destroyWaitMs`. */
  stoppedMs: number | null;
}

export interface ModalOptions {
  /** Modal App that owns the sandboxes. Created on first use. Default: `"sandbox-sdk"`. */
  app?: string;
  /**
   * Pick the App for one unkeyed create, for example one App per benchmark attempt so Modal's
   * per-App billing report prices it. Return `undefined` to use `app`. Keyed creates always use
   * `app`, because Modal keeps sandbox names unique only inside one App. `list()` scans `app` and
   * every App this provider has created into or prepared; after a restart, call `prepareApp` for
   * each App to clean up. A new App costs one lookup inside the create that first uses it;
   * `prepareApp` beforehand keeps it out of create timing.
   */
  createApp?: (input: { readonly labels: Readonly<Labels> }) => string | undefined;
  /** How long `destroy` waits for Modal to report the sandbox stopped. Default: 60 seconds. */
  destroyWaitMs?: number;
  /** Called after each terminate request with its latency and the confirmed-stop latency. */
  onDestroy?: (event: ModalDestroyEvent) => void;
  /** Modal Environment for the App and its sandboxes. Default: the profile's, or `MODAL_ENVIRONMENT`. */
  environment?: string;
  /** Registry image for fresh sandboxes; ignored with `from`. Default: `node:22-bookworm`. */
  image?: string;
  /**
   * Regions to place sandboxes in, such as `"us-east"` or `["us-east", "us-central"]`. Default:
   * `MODAL_SANDBOX_REGION` (comma-separated), else Modal picks. Pinning adds Modal's region price multiplier.
   */
  region?: string | readonly string[];
  /** Sandbox runtime. Default: Modal's choice (gVisor today). */
  runtime?: SandboxRuntime;
  /**
   * Native CPU and memory requests and limits for sandboxes created without `size`. Default: Modal's
   * request of 0.125 CPU and 128 MiB, which bursts into spare host capacity. Pass this or `size`, not both.
   */
  resources?: ModalResources;
  /** Hard lifetime for sandboxes created without `timeoutMs`, at most 24 hours. Default: Modal's 5 minutes. */
  timeoutMs?: number;
}

const sdkTag = "sandbox-sdk";
const keyTag = "sandbox-sdk-key";
const createdTag = "sandbox-sdk-created";

// Set when termination is requested: list() keeps showing the sandbox (state "stopped") until Modal
// reports it stopped, and find() stops handing it out for its key.
const destroyingTag = "sandbox-sdk-destroying";

// Earlier adapter versions overwrote the sandbox-sdk tag with this instead.
const legacyDestroyed = "destroyed";
const defaultDestroyWaitMs = 60_000;
const defaultImage = "node:22-bookworm";
const hour = 3_600_000;
const maxLifetimeMs = 24 * hour;
const maxTags = 10;
const maxTagBytes = 1024;

// Modal App names: letters, digits, dashes, periods and underscores, shorter than 64 characters.
const appNamePattern = /^[\w.-]{1,63}$/;

// Modal sandbox names must be shorter than 64 characters.
const keyName = (key: string) =>
  `sdk-${createHash("sha256").update(key).digest("hex").slice(0, 56)}`;

/** Presets pin request and limit together, so a sized sandbox gets exactly this much. */
const presets = {
  small: { cpu: 1, memoryMb: 2048 },
  medium: { cpu: 2, memoryMb: 4096 },
  large: { cpu: 4, memoryMb: 8192 },
} as const;

// A filesystem snapshot keeps process records but not the processes. Mark live ones failed.
const invalidate = `for d in /tmp/.sandbox-sdk/procs/*; do [ -f "$d/spec.json" ] && [ ! -f "$d/exit" ] && printf 137 > "$d/exit"; done; rm -rf /tmp/.sandbox-sdk/runs; true`;

// The first stderr line of every command is the adapter's: the process group ID, or a cwd failure.
const pidMarker = "__sandbox_sdk_pgid__=";
const cwdMarker = "__sandbox_sdk_cwd_error__";

// setsid gives the command its own session. GNU timeout, exec'd as that session's group leader, kills
// the whole group at the deadline even if this client disconnects. $1 cwd, $2 duration, $3 command.
const wrapper = `cd -- "$1" 2>/dev/null || { echo ${cwdMarker} >&2; exit 125; }; echo "${pidMarker}$$" >&2; exec timeout --signal=KILL "$2" sh -c "$3"`;

function seconds(ms: number): number {
  return Math.ceil(ms / 1000) * 1000;
}

function tagBytes(tags: Labels): number {
  const encoder = new TextEncoder();

  return Object.entries(tags).reduce(
    (total, [name, value]) => total + encoder.encode(name).length + encoder.encode(value).length,
    0,
  );
}

function resources(
  size: CreateInput["size"],
  fallback: ModalResources | undefined,
): ModalResources {
  if (size === undefined) return fallback ?? {};

  if (fallback !== undefined)
    invalid("Pass size to createSandbox or resources to modal(), not both.");

  if (size === "small" || size === "medium" || size === "large") return pinned(presets[size]);

  if (size.diskGb !== undefined)
    unsupported("Modal sets no disk size for a sandbox; leave diskGb unset");

  if (!Number.isFinite(size.cpu) || size.cpu < 0.125)
    unsupported("Modal needs a cpu of at least 0.125");

  if (!Number.isSafeInteger(size.memoryMb) || size.memoryMb < 128)
    unsupported("Modal needs memoryMb as a whole number of at least 128");

  return pinned(size);
}

function pinned({ cpu, memoryMb }: { cpu: number; memoryMb: number }): ModalResources {
  return { cpu, cpuLimit: cpu, memoryMiB: memoryMb, memoryLimitMiB: memoryMb };
}

const ipv4 = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;

/** Modal allows outbound traffic by CIDR or domain; an IPv4 address or CIDR goes in the CIDR list. */
function networkParams(network: CreateInput["network"]): SandboxCreateParams {
  if (network === undefined || network === "all") return {};

  // Empty allow lists block every outbound connection. Modal's blockNetwork would also cut the
  // inbound tunnels previews use, which "none" does not mean.
  if (network === "none") return { outboundCidrAllowlist: [], outboundDomainAllowlist: [] };
  const cidrs = network.allow.filter((entry) => ipv4.test(entry) || entry.includes(":"));
  const domains = network.allow.filter((entry) => !cidrs.includes(entry));

  // Both lists are always sent: an empty allow list then blocks every outbound connection.
  return {
    outboundCidrAllowlist: cidrs.map((entry) =>
      entry.includes("/") ? entry : `${entry}/${entry.includes(":") ? 128 : 32}`,
    ),
    outboundDomainAllowlist: domains,
  };
}

function regions(option: ModalOptions["region"]): string[] | undefined {
  const value = option ?? process.env.MODAL_SANDBOX_REGION;

  if (value === undefined) return undefined;

  // A string is a comma-separated list, as MODAL_SANDBOX_REGION holds it.
  const list = [value]
    .flat()
    .flatMap((entry) => entry.split(","))
    .map((region) => region.trim())
    .filter(Boolean);

  return list.length ? list : undefined;
}

function lifetime(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;

  if (ms > maxLifetimeMs) unsupported("Modal caps a sandbox's lifetime at 24 hours");

  return seconds(ms);
}

/** Read a stream to its end, handing each chunk over as it arrives. */
async function drain(stream: ReadableStream<string>, emit: (text: string) => void) {
  const reader = stream.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) return;

      if (value) emit(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** Error codes that mean the request itself failed, never that the command had already exited. */
const transportCodes: ReadonlySet<ErrorCode> = new Set(["unavailable", "auth", "timeout", "quota"]);

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function destroying(tags: Labels): boolean {
  return tags[destroyingTag] !== undefined || tags[sdkTag] === legacyDestroyed;
}

function fileInfo(entry: Awaited<ReturnType<NativeFilesystem["stat"]>>): FileInfo {
  return {
    path: entry.path,
    type: entry.type,
    size: entry.size,
    modifiedAt: entry.modifiedTime * 1000,
  };
}

/** Internal injection point used by the offline SDK contract tests. */
/** The Modal adapter: a {@link Provider} plus Modal-only helpers. */
export type ModalAdapter<N extends NativeSandbox> = Provider<N, ModalCapability> & {
  /** Look up or create an App ahead of time, so a later create that uses it pays no App lookup. */
  prepareApp(name: string): Promise<void>;
};

export function createModalProvider<N extends NativeSandbox>(
  load: () => Promise<ModalClientSlice<N>>,
  options: ModalOptions = {},
): ModalAdapter<N> {
  const boxes = new Map<string, N>();
  // Ports declared at creation by this provider instance; a connected sandbox's come from Modal.
  const declared = new Map<string, ReadonlySet<number>>();
  // The last tags seen for each sandbox, so destroy can mark it without reading them first.
  const seen = new Map<string, Labels>();
  const appName = options.app ?? "sandbox-sdk";
  const defaultLifetime = lifetime(options.timeoutMs);
  const destroyWaitMs = options.destroyWaitMs ?? defaultDestroyWaitMs;
  let client: Promise<ModalClientSlice<N>> | undefined;
  const apps = new Map<string, Promise<NativeApp>>();
  let base: NativeImage | undefined;

  // A failed load or lookup is not cached, so a fixed credential or network works on the next call.
  const sdk = () =>
    (client ??= (async () => {
      try {
        return await load();
      } catch (error) {
        client = undefined;
        throw error;
      }
    })());

  const application = (name = appName): Promise<NativeApp> => {
    if (!appNamePattern.test(name))
      invalid(
        "Modal App names use letters, digits, dashes, periods and underscores, under 64 characters.",
      );
    const known = apps.get(name);

    if (known) return known;

    const lookup = (async () => {
      try {
        return await (
          await sdk()
        ).apps.fromName(name, { createIfMissing: true, environment: options.environment });
      } catch (error) {
        apps.delete(name);
        throw error;
      }
    })();

    apps.set(name, lookup);

    return lookup;
  };

  const safe = async <T>(id: string | undefined, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      throw modalError(error, id);
    }
  };

  const ended = (id: string) =>
    new SandboxError(
      "Sandbox has finished. Modal sandboxes cannot run again once they stop. Create a new sandbox.",
      { code: "not_found", provider: "modal", sandboxId: id },
    );

  const native = (id: string): N => {
    const box = boxes.get(id);

    if (!box)
      throw new SandboxError(
        "Sandbox is not attached. No local native object exists. Connect the sandbox first.",
        { code: "not_found", provider: "modal", sandboxId: id },
      );

    return box;
  };

  const get = async (id: string) => {
    const known = boxes.get(id);

    if (known) return known;
    // fromId makes no request; the first real call reports a missing sandbox.
    const box = await (await sdk()).sandboxes.fromId(id);
    boxes.set(id, box);

    return box;
  };

  function info(id: string, tags: Labels): SandboxInfo {
    const { [keyTag]: key, [createdTag]: created, [destroyingTag]: _destroying, ...labels } = tags;

    // A sandbox being destroyed is still running until Modal says otherwise; it is not usable.
    const state = destroying(tags) ? "stopped" : "running";

    return { id, key, labels, state, createdAt: Number(created) || 0 };
  }

  /**
   * Read a sandbox's tags once it is running and set up. A finished sandbox is `not_found`; one whose
   * termination was requested but not yet confirmed is `stopped`, so cleanup can still find it.
   */
  async function attach(box: N): Promise<SandboxInfo> {
    const [exit, first] = await Promise.all([box.poll(), box.getTags()]);

    if (exit !== null) throw ended(box.sandboxId);
    let tags = first;
    const deadline = Date.now() + 60_000;

    // A snapshot restore is tagged pending until its creator has invalidated restored processes.
    while (tags[sdkTag] === "pending") {
      if (Date.now() >= deadline)
        throw new SandboxError(
          "Sandbox initialization is incomplete. The creator has not finished setup. Retry connection later.",
          { code: "unavailable", provider: "modal", sandboxId: box.sandboxId, retryable: true },
        );
      await delay(250);
      tags = await box.getTags();
    }

    boxes.set(box.sandboxId, box);
    seen.set(box.sandboxId, tags);

    return info(box.sandboxId, tags);
  }

  /** Whether `name` belongs to a destroyed sandbox, waiting up to a minute until Modal frees it. */
  async function releasing(name: string): Promise<boolean> {
    const modal = await sdk();
    let holder: N;

    try {
      holder = await modal.sandboxes.fromName(appName, name, { environment: options.environment });
    } catch (error) {
      // Freed between the failed create and this lookup.
      if (modalError(error).code === "not_found") return true;
      throw error;
    }

    if (!destroying(await holder.getTags())) return false;
    const deadline = Date.now() + 60_000;

    while ((await holder.poll()) === null) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return true;
  }

  async function shell(box: N, script: string): Promise<number> {
    const proc = await box.exec(["sh", "-c", script]);
    await proc.stdin.close();

    const [exit] = await Promise.all([
      proc.wait(),
      drain(proc.stdout, () => {}),
      drain(proc.stderr, () => {}),
    ]);

    return exit;
  }

  /** Set or clear the destroying tag. Best effort: returns whether the write went through. */
  async function mark(box: N, on: boolean): Promise<boolean> {
    try {
      const { [destroyingTag]: _previous, ...rest } =
        seen.get(box.sandboxId) ?? (await box.getTags());

      const tags = on ? { ...rest, [destroyingTag]: String(Date.now()) } : rest;
      await box.setTags(tags);
      seen.set(box.sandboxId, tags);

      return true;
    } catch {
      return false;
    }
  }

  /** Whether Modal reports the sandbox stopped within `ms`. A sandbox Modal no longer knows is stopped. */
  async function stopsWithin(box: N, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;

    for (;;) {
      try {
        if ((await box.poll()) !== null) return true;
      } catch (error) {
        if (modalError(error).code === "not_found") return true;
        throw error;
      }

      const left = deadline - Date.now();

      if (left <= 0) return false;
      await delay(Math.min(250, left));
    }
  }

  function forget(id: string) {
    boxes.get(id)?.detach();
    boxes.delete(id);
    declared.delete(id);
    seen.delete(id);
  }

  async function killGroup(box: N, group: number) {
    await shell(box, `kill -KILL -${group} 2>/dev/null || true`);
  }

  async function run(box: N, input: ExecInput): Promise<ExecResult> {
    const started = Date.now();

    const proc = await box.exec(
      [
        "setsid",
        "--wait",
        "sh",
        "-c",
        wrapper,
        "sh",
        input.cwd,
        `${Math.max(1, Math.ceil(input.timeoutMs)) / 1000}s`,
        input.command,
      ],
      { env: input.env },
    );

    let group: number | undefined;
    let groupKnown = () => {};
    const groupReady = new Promise<void>((resolve) => (groupKnown = resolve));
    let cwdFailed = false;
    let timedOut = false;
    let stopping: Promise<void> | undefined;

    const stop = () =>
      (stopping ??= (async () => {
        // The group ID is the first stderr line; it arrives right after launch.
        await Promise.race([groupReady, new Promise((resolve) => setTimeout(resolve, 10_000))]);

        if (group !== undefined) await killGroup(box, group);
      })());

    const abort = () => {
      timedOut = true;
      void stop().catch(() => {});
    };

    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, input.timeoutMs - (Date.now() - started)));

    if (input.signal?.aborted) abort();

    let head = "";
    let headDone = false;

    // Split the adapter's first stderr line off the command's own output.
    const header = (final: boolean) => {
      const newline = head.indexOf("\n");

      if (!final && newline < 0 && head.length < 256) return;
      headDone = true;
      const line = newline < 0 ? head : head.slice(0, newline);
      const rest = newline < 0 ? "" : head.slice(newline + 1);

      if (line.startsWith(pidMarker)) {
        const pid = Number(line.slice(pidMarker.length));

        if (Number.isSafeInteger(pid) && pid > 0) group = pid;
      } else if (line === cwdMarker) cwdFailed = true;
      else {
        groupKnown();
        input.onChunk({ stream: "stderr", text: head });

        return;
      }

      groupKnown();

      if (rest) input.onChunk({ stream: "stderr", text: rest });
    };

    const exited = proc.wait();
    let finished = false;
    void exited.then(
      () => (finished = true),
      () => {},
    );

    /** Whether the command exits within `ms`, as it does when it ended before reading its input. */
    const exitsWithin = async (ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        return await Promise.race([
          exited.then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms))),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    // Closing stdin right away gives the command EOF. A command that has already exited refuses the
    // write or the close; that is no failure. Any other stdin error is a transport failure: it
    // propagates, and the catch below kills the command, which would otherwise run on half its input.
    const feed = async () => {
      try {
        if (input.stdin !== undefined) await proc.stdin.writeText(input.stdin);
        await proc.stdin.close();
      } catch (error) {
        const failure = modalError(error, box.sandboxId);

        // Transport failures always propagate. Anything else counts as the exited command's refusal
        // only if the command has exited or does within a second, the time its exit status can lag.
        // Stdin is not closed first: a command still reading it stays blocked and cannot pass as done.
        if (transportCodes.has(failure.code) || !(finished || (await exitsWithin(1_000))))
          throw failure;
        void proc.stdin.close().catch(() => {});
      }
    };

    try {
      const stdin = feed();

      const [exit] = await Promise.all([
        exited,
        drain(proc.stdout, (text) => input.onChunk({ stream: "stdout", text })),
        drain(proc.stderr, (text) => {
          if (headDone) input.onChunk({ stream: "stderr", text });
          else {
            head += text;
            header(false);
          }
        }),
        stdin,
      ]);

      if (!headDone && head) header(true);

      // The remote watchdog also enforces the deadline when this client is slow to.
      if (exit === 137 && Date.now() - started >= input.timeoutMs) timedOut = true;
      await stopping;

      if (!timedOut && exit === 125 && cwdFailed)
        throw new SandboxError(
          "Command could not start. The working directory does not exist or is not a directory. Check cwd.",
          { code: "invalid_argument", provider: "modal", sandboxId: box.sandboxId },
        );

      return { exitCode: timedOut ? null : exit, timedOut };
    } catch (error) {
      await stop().catch(() => {});
      throw error;
    } finally {
      groupKnown();
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  async function withDeadline<T>(work: Promise<T>, settings: TemplateBuildOptions): Promise<T> {
    const { timeoutMs, signal } = settings;

    if (timeoutMs === undefined && signal === undefined) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};

    const limit = new Promise<never>((_, reject) => {
      if (timeoutMs !== undefined)
        timer = setTimeout(
          () =>
            reject(
              new SandboxError(
                "Template build timed out. Modal may still finish the image. Retry with a longer timeoutMs.",
                { code: "timeout", provider: "modal" },
              ),
            ),
          timeoutMs,
        );
      onAbort = () =>
        reject(
          new SandboxError("Template build aborted. Modal may still finish the image.", {
            code: "aborted",
            provider: "modal",
          }),
        );
      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) onAbort();
    });

    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  const provider: Provider<N, ModalCapability> = {
    name: "modal",
    keyMode: "exact",
    capabilities: new Set<ModalCapability>([
      "snapshot",
      "snapshot-delete",
      "templates",
      "network-policy",
      "size",
    ]),
    native,
    create: (input) =>
      safe(undefined, async () => {
        const tags: Labels = { ...input.labels, [createdTag]: String(Date.now()) };

        if (input.key !== undefined) tags[keyTag] = input.key;

        // Room stays for the tag destroy adds.
        if (Object.keys(tags).length + 1 > maxTags)
          unsupported(
            "Modal allows ten tags per sandbox, and the SDK uses up to four of them (sandbox-sdk, sandbox-sdk-created, sandbox-sdk-key, sandbox-sdk-destroying)",
          );

        if (tagBytes({ ...tags, [destroyingTag]: String(Date.now()) }) > maxTagBytes)
          unsupported("Modal allows 1024 bytes of tag names and values per sandbox, key included");
        const ports = [...new Set(input.ports)];

        const params: SandboxCreateParams = {
          ...resources(input.size, options.resources),
          ...networkParams(input.network),
          timeoutMs: lifetime(input.timeoutMs) ?? defaultLifetime,
          idleTimeoutMs:
            input.idleTimeoutMs === undefined ? undefined : seconds(input.idleTimeoutMs),
          workdir: "/workspace",
          env: input.env,
          encryptedPorts: ports.length ? ports : undefined,
          regions: regions(options.region),
          runtime: options.runtime,
          name: input.key === undefined ? undefined : keyName(input.key),
          // A restore stays hidden from list() and find() until stale process records are cleared.
          tags: input.from === undefined ? tags : { ...tags, [sdkTag]: "pending" },
        };

        const modal = await sdk();

        const image =
          input.from === undefined
            ? (base ??= modal.images.fromRegistry(options.image ?? defaultImage))
            : await modal.images.fromId(input.from);

        const owner = await application(
          input.key === undefined
            ? (options.createApp?.({ labels: input.labels }) ?? appName)
            : appName,
        );

        let box: N;

        try {
          box = await modal.sandboxes.create(owner, image, params);
        } catch (error) {
          // A destroyed sandbox holds its name until Modal finishes stopping it. Wait for that, once.
          if (params.name === undefined || !(await releasing(params.name))) throw error;
          box = await modal.sandboxes.create(owner, image, params);
        }

        boxes.set(box.sandboxId, box);
        declared.set(box.sandboxId, new Set(ports));
        seen.set(box.sandboxId, tags);

        if (input.from === undefined) return info(box.sandboxId, tags);

        try {
          if ((await shell(box, invalidate)) !== 0)
            throw new Error("Could not invalidate restored processes");
          await box.setTags(tags);

          return info(box.sandboxId, tags);
        } catch (error) {
          await provider.destroy(box.sandboxId).catch(() => {});
          throw error;
        }
      }),
    find: (key) =>
      safe(undefined, async () => {
        let box: N;

        try {
          box = await (
            await sdk()
          ).sandboxes.fromName(appName, keyName(key), { environment: options.environment });
        } catch (error) {
          if (modalError(error).code === "not_found") return undefined;
          throw error;
        }

        let found: SandboxInfo;

        try {
          found = await attach(box);
        } catch (error) {
          if (modalError(error).code === "not_found") return undefined;
          throw error;
        }

        // A sandbox being destroyed is not handed out; create waits for Modal to free its name.
        if (found.labels[sdkTag] !== "1" || found.key !== key || found.state === "stopped")
          return undefined;

        return found;
      }),
    connect: (id) =>
      safe(id, async () => attach(boxes.get(id) ?? (await (await sdk()).sandboxes.fromId(id)))),
    list: (labels) =>
      safe(undefined, async () => {
        const modal = await sdk();
        await application();

        // Modal deprecates listing a whole Environment, so scan each App this provider has used or
        // prepared: `app` alone unless createApp has picked others.
        const owners = (await Promise.allSettled(apps.values())).flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );

        const filter = { ...labels, [sdkTag]: "1" };
        const found = new Map<string, N>();

        // Modal filters by tags server-side and lists only running sandboxes.
        for (const owner of owners)
          for await (const box of modal.sandboxes.list({
            appId: owner.appId,
            tags: filter,
            environment: options.environment,
          }))
            found.set(box.sandboxId, box);

        const items = await Promise.all(
          [...found.values()].map(async (box) => {
            try {
              return await attach(box);
            } catch (error) {
              // A sandbox that ended between the listing and the tag read is no longer listed.
              if (modalError(error, box.sandboxId).code === "not_found") return undefined;
              throw error;
            }
          }),
        );

        return items.filter(
          (item): item is SandboxInfo =>
            item !== undefined && Object.entries(filter).every(([k, v]) => item.labels[k] === v),
        );
      }),
    destroy: (id) =>
      safe(id, async () => {
        const box = await get(id);
        const started = Date.now();
        // The mark is advisory and runs beside terminate: a failed tag write never blocks termination.
        const marking = mark(box, true);

        try {
          await box.terminate();
        } catch (error) {
          const marked = await marking;

          if (modalError(error).code === "not_found") return forget(id);

          // Still running and not stopping: drop the mark, so it stays an ordinary running sandbox.
          if (marked) await mark(box, false);
          throw error;
        }

        const requestMs = Date.now() - started;
        await marking;
        // Modal sometimes takes ~30 s to stop a sandbox after terminate, and bills until it stops.
        const stopped = await stopsWithin(box, destroyWaitMs);
        const stoppedMs = stopped ? Date.now() - started : null;

        try {
          options.onDestroy?.({ sandboxId: id, requestMs, stoppedMs });
        } catch {
          // An observer failure is not a destroy failure.
        }

        if (!stopped)
          throw new SandboxError(
            `Sandbox termination was requested, but Modal still reports it running after ${Math.round(destroyWaitMs / 1000)} s. It stays listed with state "stopped". Call destroy again to keep waiting.`,
            { code: "timeout", provider: "modal", sandboxId: id, retryable: true },
          );
        forget(id);
      }),
    exec: (id, input) =>
      safe(id, async () => {
        if (input.signal?.aborted) return { exitCode: null, timedOut: true };

        return run(await get(id), input);
      }),
    files: {
      writeCreatesParents: true,
      read: (id, path) =>
        safe(id, async () => new Uint8Array(await (await get(id)).filesystem.readBytes(path))),
      write: (id, path, data) =>
        safe(id, async () => {
          await (await get(id)).filesystem.writeBytes(data, path);
        }),
      list: (id, path) =>
        safe(id, async () => (await (await get(id)).filesystem.listFiles(path)).map(fileInfo)),
      stat: (id, path) =>
        safe(id, async () => fileInfo(await (await get(id)).filesystem.stat(path))),
      remove: (id, path, settings) =>
        safe(id, async () => {
          await (await get(id)).filesystem.remove(path, { recursive: settings.recursive });
        }),
      mkdir: (id, path) =>
        safe(id, async () => {
          await (await get(id)).filesystem.makeDirectory(path, { createParents: true });
        }),
    },
    previewUrl: (id, port) =>
      safe(id, async () => {
        const known = declared.get(id);

        const undeclared = () =>
          new SandboxError(
            `Port ${port} was not declared at creation. Modal tunnels only ports given in CreateInput. Recreate with ports: [${port}].`,
            { code: "invalid_argument", provider: "modal", sandboxId: id },
          );

        // Modal waits for tunnels that may never come; skip the wait when the port was never declared.
        if (known && !known.has(port)) throw undeclared();
        const tunnel = (await (await get(id)).tunnels())[port];

        if (!tunnel) throw undeclared();

        return { url: tunnel.url };
      }),
    close: async (id) => forget(id),
    snapshot: (id, settings = {}) =>
      safe(id, async () => {
        const { expiresInMs } = settings;

        // Modal keeps a filesystem snapshot for 30 days unless told otherwise; null keeps it forever.
        const ttlMs =
          expiresInMs === undefined ? undefined : expiresInMs === 0 ? null : seconds(expiresInMs);

        return { id: (await (await get(id)).snapshotFilesystem({ ttlMs })).imageId };
      }),
    deleteSnapshot: (snapshotId) =>
      safe(undefined, async () => {
        const modal = await sdk();

        // Modal's delete succeeds for an image that is already gone, so look it up first.
        try {
          await modal.images.fromId(snapshotId);
        } catch (error) {
          if (modalError(error).code === "not_found") return false;
          throw error;
        }

        await modal.images.delete(snapshotId);

        return true;
      }),
    buildTemplate: (spec: TemplateSpec, settings: TemplateBuildOptions): Promise<TemplateInfo> =>
      safe(undefined, async () => {
        if (spec.size !== undefined)
          unsupported(
            "Modal images carry no CPU or memory size. Pass size to createSandbox instead",
          );

        if (
          spec.workdir !== undefined &&
          (!spec.workdir.startsWith("/") || /[\r\n]/.test(spec.workdir))
        )
          invalid("Template workdir must be an absolute path on one line.");

        const commands = [
          ...(spec.workdir === undefined ? [] : [`WORKDIR ${spec.workdir}`]),
          // Exec form, so each step reaches sh -c as one argument, whatever it contains.
          ...(spec.run ?? []).map((step) => `RUN ${JSON.stringify(["sh", "-c", step])}`),
        ];

        const modal = await sdk();
        const registry = modal.images.fromRegistry(spec.image ?? options.image ?? defaultImage);

        const image = commands.length
          ? registry.dockerfileCommands(commands, { env: spec.env })
          : registry;

        const built = await withDeadline(
          application().then((owner) => image.build(owner)),
          settings,
        );

        return { id: built.imageId, name: spec.name };
      }),
  };

  return Object.assign(provider, {
    prepareApp: (name: string) =>
      safe(undefined, async () => {
        await application(name);
      }),
  });
}

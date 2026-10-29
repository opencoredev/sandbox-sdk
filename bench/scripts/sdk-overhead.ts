/** Measures SDK, adapter and independent native SDK costs. See bench/README.md. */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Core from "@opencoredev/sandbox-sdk";
import type { CreateInput, Provider } from "@opencoredev/sandbox-sdk/provider";

type Sdk = typeof Core;

type Sandbox = Awaited<ReturnType<Sdk["createSandbox"]>>;

// write is absent when the native SDK cannot reach /workspace (Tenki confines writeFile to its workdir).
interface Floor {
  exec(command?: string): Promise<unknown>;
  write?(path: string, data: Uint8Array): Promise<void>;
}

interface Loaded {
  provider: Provider;
  floor(id: string): Floor;
}

const { values } = parseArgs({
  options: {
    providers: { type: "string", default: "e2b,daytona,upstash,boxd,freestyle,tenki,superserve" },
    n: { type: "string", default: "10" },
    sandboxes: { type: "string", default: "5" },
    out: { type: "string" },
    sdk: { type: "string", default: fileURLToPath(new URL("../../packages/sdk", import.meta.url)) },
    // Same factory templates as bench/src/collection-plan.sh's default track.
    template: { type: "string", multiple: true, default: [] },
  },
});

const n = Number(values.n);
const sandboxCount = Number(values.sandboxes);

if (!Number.isInteger(n) || n < 1 || !Number.isInteger(sandboxCount) || sandboxCount < 1)
  throw new Error("--n and --sandboxes must be positive integers");

const sdkRoot = resolve(values.sdk);
const runId = `sbx57-${Date.now().toString(36)}`;
const label = { "sdk-overhead-run": runId };
const moduleUrl = (path: string) => pathToFileURL(resolve(sdkRoot, "dist", path)).href;

const nativeUrl = (name: string) =>
  import.meta.resolve(name, pathToFileURL(resolve(sdkRoot, "package.json")).href);

const nativePackages: Record<string, string> = {
  e2b: "e2b",
  daytona: "@daytonaio/sdk",
  upstash: "@upstash/box",
  boxd: "@boxd-sh/sdk",
  freestyle: "freestyle",
  tenki: "@tenkicloud/sandbox",
  superserve: "@superserve/sdk",
};

const sdk: Sdk = await import(moduleUrl("index.js"));
const timeoutMs = 60_000;

const templates = new Map(
  ["e2b=base", "superserve=sandbox-bench-node22-py311-1x1-pinned", ...values.template].map(
    (pair) => {
      const at = pair.indexOf("=");

      if (at < 1) throw new Error(`--template expects provider=name, got ${pair}`);

      return [pair.slice(0, at), pair.slice(at + 1)];
    },
  ),
);

// Each entry types native() through the adapter module's own Provider<Native>.
const providers: Record<string, () => Promise<Loaded>> = {
  async e2b() {
    const m: typeof import("@opencoredev/sandbox-sdk/e2b") = await import(
      moduleUrl("providers/e2b/index.js")
    );

    const template = templates.get("e2b");
    const provider = m.e2b(template === undefined ? {} : { template });

    return {
      provider,
      floor: (id) => {
        const box = provider.native(id);

        return {
          exec: async (command = "true") => {
            await box.commands.run(command, { user: "root" });
          },
          write: async (path, data) => {
            await box.files.write(path, new Uint8Array(data).buffer, { user: "root" });
          },
        };
      },
    };
  },
  async daytona() {
    const m: typeof import("@opencoredev/sandbox-sdk/daytona") = await import(
      moduleUrl("providers/daytona/index.js")
    );

    const provider = m.daytona();

    return {
      provider,
      floor: (id) => {
        const box = provider.native(id);

        return {
          exec: async (command = "true") => {
            const r = await box.process.executeCommand(command);

            if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
          },
          write: (path, data) => box.fs.uploadFile(Buffer.from(data), path),
        };
      },
    };
  },
  async upstash() {
    const m: typeof import("@opencoredev/sandbox-sdk/upstash") = await import(
      moduleUrl("providers/upstash/index.js")
    );

    const provider = m.upstash();

    return {
      provider,
      floor: (id) => {
        const box = provider.native(id);

        return {
          exec: async (command = "true") => {
            await box.exec.command(command);
          },
          write: async (path, data) => {
            await box.files.write({
              path,
              content: Buffer.from(data).toString("base64"),
              encoding: "base64",
            });
          },
        };
      },
    };
  },
  async boxd() {
    const m: typeof import("@opencoredev/sandbox-sdk/boxd") = await import(
      moduleUrl("providers/boxd/index.js")
    );

    const provider = m.boxd();

    return {
      provider,
      floor: (id) => {
        const { client } = provider.native(id);

        return {
          exec: async (command = "true") => {
            await client.machines.exec(id, { command, timeout: timeoutMs });
          },
          write: async (path, data) => {
            await client.machines.files.upload(id, path, data);
          },
        };
      },
    };
  },
  async freestyle() {
    const m: typeof import("@opencoredev/sandbox-sdk/freestyle") = await import(
      moduleUrl("providers/freestyle/index.js")
    );

    const provider = m.freestyle();

    return {
      provider,
      floor: (id) => {
        const vm = provider.native(id);

        return {
          exec: async (command = "true") => {
            const r = await vm.exec({ command, linuxUser: "root", timeoutMs });

            if (r.statusCode !== 0) throw new Error(`exit ${r.statusCode}`);
          },
          write: async (path, data) => {
            await vm.fs.writeFile(path, data);
          },
        };
      },
    };
  },
  async tenki() {
    const m: typeof import("@opencoredev/sandbox-sdk/tenki") = await import(
      moduleUrl("providers/tenki/index.js")
    );

    const provider = m.tenki();

    return {
      provider,
      floor: (id) => {
        const session = provider.native(id);

        return {
          exec: async (command = "true") => {
            const r = await session.run(["sh", "-c", command], { privileged: true, timeoutMs });

            if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
          },
        };
      },
    };
  },
  async superserve() {
    const m: typeof import("@opencoredev/sandbox-sdk/superserve") = await import(
      moduleUrl("providers/superserve/index.js")
    );

    const template = templates.get("superserve");
    const provider = m.superserve(template === undefined ? {} : { template });

    return {
      provider,
      floor: (id) => {
        const box = provider.native(id);

        return {
          exec: async (command = "true") => {
            await box.commands.run(command, { timeoutMs });
          },
          write: async (path, data) => {
            await box.files.write(path, data, { timeoutMs });
          },
        };
      },
    };
  },
};

interface NativeBox {
  id: string;
  exec(): Promise<unknown>;
  destroy(): Promise<unknown>;
  exists(): Promise<boolean>;
}

const nativeClients: {
  boxd?: InstanceType<(typeof import("../../packages/sdk/node_modules/@boxd-sh/sdk"))["Boxd"]>;
  tenki?: InstanceType<
    (typeof import("../../packages/sdk/node_modules/@tenkicloud/sandbox"))["TenkiSandbox"]
  >;
} = {};

// Modules resolve from the selected SDK build, not from the harness checkout.
async function rawCreate(name: string, admit: (box: NativeBox) => void): Promise<NativeBox> {
  if (name === "e2b") {
    const m: typeof import("../../packages/sdk/node_modules/e2b") = await import(nativeUrl("e2b"));

    const box = await m.Sandbox.create(templates.get(name) ?? "base", {
      metadata: label,
      lifecycle: { onTimeout: "kill", autoResume: false },
      allowInternetAccess: true,
    });

    return {
      id: box.sandboxId,
      exec: async () => {
        await box.commands.run("true", { user: "root" });
      },
      destroy: () => box.kill(),
      exists: async () => {
        try {
          await box.getInfo();

          return true;
        } catch (error) {
          if (error instanceof m.SandboxNotFoundError) return false;
          throw error;
        }
      },
    };
  }

  if (name === "daytona") {
    const m: typeof import("../../packages/sdk/node_modules/@daytonaio/sdk") = await import(
      nativeUrl("@daytonaio/sdk")
    );

    const client = new m.Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET ?? "us",
      requestTimeoutMs: 30000,
    });

    const box = await client.create(
      { labels: label, public: false, autoPauseInterval: 0 },
      { timeout: 60 },
    );

    return {
      id: box.id,
      exec: async () => {
        const r = await box.process.executeCommand("true");

        if (r.exitCode) throw new Error(`exit ${r.exitCode}`);
      },
      destroy: () => client.delete(box),
      exists: async () => {
        const b = await client.get(box.id);

        return b.state !== "deleted";
      },
    };
  }

  if (name === "upstash") {
    const m: typeof import("../../packages/sdk/node_modules/@upstash/box") = await import(
      nativeUrl("@upstash/box")
    );

    const box = await m.Box.create({
      apiKey: process.env.UPSTASH_BOX_API_KEY,
      labels: [runId],
      networkPolicy: { mode: "allow-all" },
    });

    return {
      id: box.id,
      exec: async () => {
        const r = await box.exec.command("true");

        if (r.exitCode) throw new Error(`exit ${r.exitCode}`);
      },
      destroy: () => box.delete(),
      exists: async () => (await box.getStatus()).status !== "deleted",
    };
  }

  if (name === "boxd") {
    const m: typeof import("../../packages/sdk/node_modules/@boxd-sh/sdk") = await import(
      nativeUrl("@boxd-sh/sdk")
    );

    const client = (nativeClients.boxd ??= new m.Boxd({
      apiKey: process.env.BOXD_API_KEY,
      timeout: 30000,
      maxRetries: 0,
    }));

    const box = await client.machines.create({
      name: `${runId}-${crypto.randomUUID()}`,
      isolated: true,
      config: { autoSuspendTimeout: 0, autoDestroyTimeout: 0 },
    });

    const raw = {
      id: box.id,
      exec: async () => {
        const r = await client.machines.exec(box.id, { command: "true", timeout: timeoutMs });

        if (r.exitCode) throw new Error(`exit ${r.exitCode}`);
      },
      destroy: () => client.machines.delete(box.id),
      exists: async () => {
        const b = await client.machines.get(box.id);

        return !["destroyed", "deleted"].includes(b.status);
      },
    };

    admit(raw);

    if (box.status !== "running") await client.machines.waitUntilReady(box.id, { timeout: 90000 });

    return raw;
  }

  if (name === "freestyle") {
    const m: typeof import("../../packages/sdk/node_modules/freestyle") = await import(
      nativeUrl("freestyle")
    );

    const client = new m.Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });

    const { vm: box, vmId: id } = await client.vms.create({
      snapshotId: "freestyle/ubuntu",
      metadata: label,
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
      tls: { rules: [] },
      vpcs: [],
      idleTimeoutSeconds: -1,
    });

    return {
      id,
      exec: async () => {
        const r = await box.exec({ command: "true", linuxUser: "root", timeoutMs });

        if (r.statusCode !== 0) throw new Error(`exit ${r.statusCode}`);
      },
      destroy: () => box.delete(),
      exists: async () => {
        const b = await client.vms.get(id);

        return !["deleted", "destroyed"].includes(b.state);
      },
    };
  }

  if (name === "tenki") {
    const m: typeof import("../../packages/sdk/node_modules/@tenkicloud/sandbox") = await import(
      nativeUrl("@tenkicloud/sandbox")
    );

    const client = (nativeClients.tenki ??= new m.TenkiSandbox({
      authToken: process.env.TENKI_AUTH_TOKEN ?? process.env.TENKI_API_KEY,
    }));

    // Keep the admitted ID before readiness, so a readiness failure can still be cleaned up.
    const box = await client.create({
      metadata: label,
      sticky: false,
      allowInbound: true,
      allowOutbound: true,
      waitReady: false,
    });

    const raw = {
      id: box.id,
      exec: async () => {
        const r = await box.run(["true"], { privileged: true, timeoutMs });

        if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      },
      destroy: () => box.close(),
      exists: async () => (await client.get(box.id)).state !== "TERMINATED",
    };

    admit(raw);
    await box.waitReady(60000, AbortSignal.timeout(60000));

    return raw;
  }

  if (name === "superserve") {
    const m: typeof import("../../packages/sdk/node_modules/@superserve/sdk") = await import(
      nativeUrl("@superserve/sdk")
    );

    const box = await m.Sandbox.create({
      apiKey: process.env.SUPERSERVE_API_KEY,
      name: `${runId}-${crypto.randomUUID()}`,
      metadata: label,
      previewAccess: "private",
      fromTemplate: templates.get(name) ?? "superserve/node-22",
      signal: AbortSignal.timeout(90000),
    });

    return {
      id: box.id,
      exec: async () => {
        const r = await box.commands.run("true", { timeoutMs });

        if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`);
      },
      destroy: () => box.kill(),
      exists: async () => (await box.getInfo()).status !== "deleted",
    };
  }

  throw new Error(`Unknown provider ${name}`);
}

async function initCost(name: string): Promise<OpResult> {
  const pkg = nativePackages[name];

  if (!pkg) throw new Error(`Unknown provider ${name}`);

  const sample = async (ours: boolean) => {
    const code = ours
      ? `const t=performance.now(); await import(${JSON.stringify(moduleUrl("index.js"))}); const m=await import(${JSON.stringify(moduleUrl(`providers/${name}/index.js`))}); m[${JSON.stringify(name)}](${JSON.stringify(templates.has(name) ? { template: templates.get(name) } : {})}); console.log(performance.now()-t);`
      : `const t=performance.now(); await import(${JSON.stringify(nativeUrl(pkg))}); console.log(performance.now()-t);`;

    const output = execFileSync(process.execPath, ["--eval", code], {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const ms = Number(output.trim());

    if (!Number.isFinite(ms) || !output.trim()) throw new Error("Invalid init timing");

    return ms;
  };

  const result: OpResult = { sdk: [], baseline: [] };

  for (let i = 0; i < sandboxCount; i++) {
    if (i % 2 === 0) {
      result.sdk.push(await sample(true));
      result.baseline.push(await sample(false));
    } else {
      result.baseline.push(await sample(false));
      result.sdk.push(await sample(true));
    }
  }

  return result;
}

interface Stats {
  n: number;
  median: number;
  p90: number;
  min: number;
  max: number;
}

function stats(samples: readonly number[]): Stats | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);

  const rank = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;

  const round = (value: number) => Math.round(value * 10) / 10;

  return {
    n: sorted.length,
    median: round(rank(0.5)),
    p90: round(rank(0.9)),
    min: round(sorted[0] ?? 0),
    max: round(sorted.at(-1) ?? 0),
  };
}

const delta = (a: Stats | null, b: Stats | null) =>
  a && b ? Math.round((a.median - b.median) * 10) / 10 : null;

const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 300);

async function time(action: () => Promise<unknown>) {
  const start = performance.now();
  await action();

  return performance.now() - start;
}

interface OpResult {
  sdk: number[];
  baseline: number[];
  error?: string;
}

interface Pair {
  sdk(): Promise<unknown>;
  baseline(): Promise<unknown>;
}

// One unrecorded warm-up pair, then N recorded pairs with the call order flipped every iteration.
async function measurePair(pair: Pair): Promise<OpResult> {
  const result: OpResult = { sdk: [], baseline: [] };

  try {
    await pair.sdk();
    await pair.baseline();

    for (let i = 0; i < n; i++) {
      let sdkMs: number, baselineMs: number;

      if (i % 2 === 0) {
        sdkMs = await time(pair.sdk);
        baselineMs = await time(pair.baseline);
      } else {
        baselineMs = await time(pair.baseline);
        sdkMs = await time(pair.sdk);
      }

      result.sdk.push(sdkMs);
      result.baseline.push(baselineMs);
    }
  } catch (error) {
    result.error = message(error);
  }

  return result;
}

const path = "/workspace/sdk-overhead.txt";
const text = `hello world alpha\n${"x".repeat(1024 - 19)}\n`;
const bytes = new TextEncoder().encode(text);

const checked = async (result: PromiseLike<{ ok: boolean; exitCode: number | null }>) => {
  const r = await result;

  if (!r.ok) throw new Error(`exit ${r.exitCode}`);
};

async function adapterOps(box: Sandbox, provider: Provider) {
  const id = box.id;

  const exec = async (command: string) => {
    const r = await provider.exec(id, {
      command,
      cwd: "/workspace",
      env: {},
      timeoutMs,
      streaming: false,
      onChunk() {},
    });

    if (r.exitCode !== 0 || r.timedOut) throw new Error(`exit ${r.exitCode}`);
  };

  let token = "alpha";

  const swap = () => {
    const from = token;
    token = from === "alpha" ? "beta" : "alpha";

    return { find: from, replace: token };
  };

  const ops: Record<string, Pair> = {
    run: { sdk: () => checked(box.run("true")), baseline: () => exec("true") },
    write: {
      sdk: () => box.files.write(path, text),
      baseline: () => provider.files.write(id, path, bytes),
    },
    read: { sdk: () => box.files.read(path), baseline: () => provider.files.read(id, path) },
    edit: {
      sdk: () => box.files.edit(path, swap()),
      baseline: async () => {
        const { find, replace } = swap();
        const current = new TextDecoder().decode(await provider.files.read(id, path));

        if (!current.includes(find)) throw new Error("edit target missing");
        await provider.files.write(
          id,
          path,
          new TextEncoder().encode(current.replace(find, replace)),
        );
      },
    },
    list: {
      sdk: () => box.files.list("/workspace"),
      baseline: () => provider.files.list(id, "/workspace"),
    },
    grep: {
      sdk: () => checked(box.run(`grep hello ${path}`)),
      baseline: () => exec(`grep hello ${path}`),
    },
  };

  const results: Record<string, OpResult> = {};

  for (const [name, pair] of Object.entries(ops)) {
    if (name === "edit") {
      await box.files.write(path, text);
      token = "alpha";
    }

    results[name] = await measurePair(pair);
  }

  return results;
}

async function floorOps(box: Sandbox, floor: Floor) {
  const results: Record<string, OpResult> = {};
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

  const write =
    floor.write ??
    (async (p: string, data: Uint8Array) => {
      await floor.exec(
        `printf %s ${quote(Buffer.from(data).toString("base64"))} | base64 -d > ${quote(p)}`,
      );
    });

  let token = "alpha";

  const swap = () => {
    const find = token;
    token = token === "alpha" ? "beta" : "alpha";

    return { find, replace: token };
  };

  const pairs: Record<string, Pair> = {
    run: { sdk: () => checked(box.run("true")), baseline: () => floor.exec() },
    write: { sdk: () => box.files.write(path, text), baseline: () => write(path, bytes) },
    read: { sdk: () => box.files.read(path), baseline: () => floor.exec(`cat ${quote(path)}`) },
    edit: {
      sdk: () => box.files.edit(path, swap()),
      baseline: () => {
        const { find, replace } = swap();

        return floor.exec(`sed -i 's/${find}/${replace}/' ${quote(path)}`);
      },
    },
    list: {
      sdk: () => box.files.list("/workspace"),
      baseline: () => floor.exec("ls -la /workspace"),
    },
    grep: {
      sdk: () => checked(box.run(`grep hello ${path}`)),
      baseline: () => floor.exec(`grep hello ${quote(path)}`),
    },
  };

  for (const [name, pair] of Object.entries(pairs)) {
    if (name === "edit") {
      await box.files.write(path, text);
      token = "alpha";
    }

    results[name] = await measurePair(pair);
  }

  return results;
}

interface HandleSample {
  totalMs: number;
  createMs: number;
  handleMs: number;
}

interface ProviderReport {
  name: string;
  error?: string;
  handle: {
    samples: HandleSample[];
    total: Stats | null;
    create: Stats | null;
    handle: Stats | null;
  };
  ops: Record<
    string,
    {
      sdk: Stats | null;
      sdkWithFloor: Stats | null;
      adapter: Stats | null;
      floor: Stats | null;
      overVsAdapterMs: number | null;
      overVsFloorMs: number | null;
      errors: string[];
    }
  >;
  cold: { sdk: number[]; native: number[]; nativeCreate: number[] };
  init: OpResult;
  nativeIds: string[];
  sdkIds: string[];
  samples: { adapter: Record<string, OpResult>; floor: Record<string, OpResult> };
  metrics: Record<
    string,
    { sdk: Stats | null; baseline: Stats | null; deltaMs: number | null; pairedDelta: Stats | null }
  >;
  nativeLeftover: number | null;
  nativeOutcomeUnknown: boolean;
  sandboxesCreated: number;
  leftover: number | null;
}

async function measureProvider(name: string): Promise<ProviderReport> {
  const report: ProviderReport = {
    name,
    handle: { samples: [], total: null, create: null, handle: null },
    ops: {},
    cold: { sdk: [], native: [], nativeCreate: [] },
    init: { sdk: [], baseline: [] },
    nativeIds: [],
    sdkIds: [],
    samples: { adapter: {}, floor: {} },
    metrics: {},
    nativeLeftover: null,
    nativeOutcomeUnknown: false,
    sandboxesCreated: 0,
    leftover: null,
  };

  const load = providers[name];

  if (!load) {
    report.error = "Unknown provider";

    return report;
  }

  let loaded: Loaded;

  try {
    loaded = await load();
  } catch (error) {
    report.error = `load: ${message(error)}`;

    return report;
  }

  const { provider } = loaded;

  try {
    report.init = await initCost(name);
  } catch (error) {
    report.error = `init: ${message(error)}`;

    return report;
  }

  const nativeBoxes: NativeBox[] = [];
  let createMs = 0;

  const tracked = new Proxy(provider, {
    get(target, key) {
      if (key === "create")
        return async (input: CreateInput) => {
          const start = performance.now();

          try {
            return await target.create(input);
          } finally {
            createMs = performance.now() - start;
          }
        };

      return Reflect.get(target, key, target);
    },
  });

  const adapter = report.samples.adapter;
  const floor = report.samples.floor;

  try {
    for (let s = 0; s < sandboxCount; s++) {
      console.error(`[${name}] cold pair ${s + 1}/${sandboxCount}`);

      const ours = async () => {
        const start = performance.now();
        const box = await sdk.createSandbox(tracked, { labels: label });
        const totalMs = performance.now() - start;
        report.sandboxesCreated++;
        report.sdkIds.push(box.id);
        live.set(box.id, () => box.destroy());
        report.handle.samples.push({ totalMs, createMs, handleMs: totalMs - createMs });

        try {
          await checked(box.run("true"));
          report.cold.sdk.push(performance.now() - start);

          if (s === 0) {
            Object.assign(adapter, await adapterOps(box, provider));
            Object.assign(floor, await floorOps(box, loaded.floor(box.id)));
          }
        } finally {
          await destroySdk(box, provider);
          live.delete(box.id);
        }
      };

      const native = async () => {
        const start = performance.now();

        const admit = (box: NativeBox) => {
          report.sandboxesCreated++;
          nativeBoxes.push(box);
          report.nativeIds.push(box.id);
          live.set(box.id, box.destroy);
        };

        const prior = nativeBoxes.length;
        let box: NativeBox;

        try {
          box = await rawCreate(name, admit);
        } catch (error) {
          if (nativeBoxes.length === prior) report.nativeOutcomeUnknown = true;
          throw error;
        }

        if (!nativeBoxes.includes(box)) admit(box);
        report.cold.nativeCreate.push(performance.now() - start);

        try {
          await box.exec();
          report.cold.native.push(performance.now() - start);
        } finally {
          await destroyNative(box);
          live.delete(box.id);
        }
      };

      if (s % 2 === 0) {
        await ours();
        await native();
      } else {
        await native();
        await ours();
      }
    }
  } catch (error) {
    report.error = message(error);
  }

  // Retry only IDs admitted by this run. Raw objects deliberately lack adapter ownership markers.
  for (const box of nativeBoxes) await box.destroy().catch(() => {});

  for (const [id, destroy] of live) {
    try {
      await destroy();
      live.delete(id);
    } catch (error) {
      report.error ??= `cleanup: ${message(error)}`;
    }
  }

  report.leftover = await sweep(provider);

  try {
    report.nativeLeftover = (
      await Promise.all(nativeBoxes.map(async (box) => !(await waitAbsent(box))))
    ).filter(Boolean).length;
  } catch {
    report.nativeLeftover = null;
  }

  if (report.nativeOutcomeUnknown) report.nativeLeftover = null;
  const samples = report.handle.samples;
  report.handle.total = stats(samples.map((x) => x.totalMs));
  report.handle.create = stats(samples.map((x) => x.createMs));
  report.handle.handle = stats(samples.map((x) => x.handleMs));

  const metric = (ours: number[], baseline: number[]) => ({
    sdk: stats(ours),
    baseline: stats(baseline),
    deltaMs: delta(stats(ours), stats(baseline)),
    pairedDelta: stats(
      ours.flatMap((value, i) => (baseline[i] === undefined ? [] : [value - baseline[i]])),
    ),
  });

  report.metrics = {
    createVsNative: metric(
      samples.map((x) => x.totalMs),
      report.cold.nativeCreate,
    ),
    adapterCreateVsNative: metric(
      samples.map((x) => x.createMs),
      report.cold.nativeCreate,
    ),
    coldVsNative: metric(report.cold.sdk, report.cold.native),
    initVsNative: metric(report.init.sdk, report.init.baseline),
  };

  for (const op of ["run", "write", "read", "edit", "list", "grep"]) {
    const a = adapter[op];
    const f = floor[op];

    if (!a) continue;
    // SDK-vs-floor uses the SDK samples paired with the floor phase.
    const sdkStats = stats(a.sdk);
    const adapterStats = stats(a.baseline);
    const floorStats = f ? stats(f.baseline) : null;
    report.ops[op] = {
      sdk: sdkStats,
      sdkWithFloor: f ? stats(f.sdk) : null,
      adapter: adapterStats,
      floor: floorStats,
      overVsAdapterMs: delta(sdkStats, adapterStats),
      overVsFloorMs: f ? delta(stats(f.sdk), floorStats) : null,
      errors: [a.error, f?.error].filter((x): x is string => x !== undefined),
    };
  }

  return report;
}

// Destroys anything still labelled with this run and returns how many remain afterwards.
async function sweep(provider: Provider): Promise<number | null> {
  try {
    for (const info of await sdk.listSandboxes(provider, { labels: label }))
      await provider.destroy(info.id).catch(() => {});

    // Deletion is asynchronous on some providers, so give the list up to 60 s to drain.
    for (let attempt = 0; ; attempt++) {
      const left = (await sdk.listSandboxes(provider, { labels: label })).length;

      if (left === 0 || attempt === 12) return left;
      await new Promise((done) => setTimeout(done, 5000));
    }
  } catch {
    return null;
  }
}

async function destroySdk(box: Sandbox, provider: Provider): Promise<void> {
  await box.destroy();

  if ((await sweep(provider)) !== 0) throw new Error("SDK cleanup unverified; stopping creates");
}

async function destroyNative(box: NativeBox): Promise<void> {
  await box.destroy();

  if (!(await waitAbsent(box))) throw new Error("Native cleanup unverified; stopping creates");
}

async function waitAbsent(box: NativeBox): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (!(await box.exists())) return true;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (("status" in error && error.status === 404) ||
          ("statusCode" in error && error.statusCode === 404) ||
          ("grpcCode" in error && error.grpcCode === 5) ||
          ("code" in error && (error.code === "not_found" || error.code === 5)))
      )
        return true;
      throw error;
    }

    if (attempt === 12) return false;
    await new Promise((done) => setTimeout(done, 2500));
  }
}

const live = new Map<string, () => Promise<unknown>>();

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void Promise.allSettled([...live.values()].map((destroy) => destroy())).finally(() =>
      process.exit(130),
    );
  });

function sdkCommit() {
  try {
    const head = execFileSync("git", ["-C", sdkRoot, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const dirty =
      execFileSync("git", ["-C", sdkRoot, "status", "--porcelain", "--", "."], {
        encoding: "utf8",
      }).trim() !== "";

    return dirty ? `${head}-dirty` : head;
  } catch {
    return null;
  }
}

const fmt = (s: Stats | null) =>
  s ? `${s.median.toFixed(1)} [${s.min.toFixed(1)}–${s.max.toFixed(1)}]` : "–";

const sign = (value: number | null) =>
  value === null ? "–" : `${value > 0 ? "+" : ""}${value.toFixed(0)}`;

function markdown(reports: ProviderReport[]) {
  const lines = [
    `SDK overhead, ${runId}, sdk ${sdkCommit() ?? "unknown"}, N=${n} ops, ${sandboxCount} cold/init samples. Times in ms, median [min–max]. Δ = SDK median − baseline median.`,
    "",
    "Native-phase SDK timings and complete paired samples are in JSON. Native read/list/edit use cat/ls/sed through native exec; Tenki write uses native exec + base64. These are shell floors, not equivalent file API semantics. Tenki SDK/native phase follows native() cache invalidation. Create clocks exclude explicit init measurement but include lazy first-use imports/clients (first sample). Upstash is durable; raw create omits adapter initCommand. Raw readiness uses native waits; boxd waitUntilReady may probe true; Tenki native wait may differ from adapter stream fallback.",
    "",
    "| Provider | Op | SDK (adapter phase) | Adapter | Δ adapter | SDK (native phase) | Provider SDK | Δ provider SDK |",
    "|---|---|---|---|---|---|---|---|",
  ];

  for (const r of reports) {
    const h = r.handle;
    lines.push(
      `| ${r.name} | create floor | ${fmt(h.total)} | ${fmt(h.create)} | ${sign(delta(h.total, h.create))} | | ${fmt(stats(r.cold.nativeCreate))} | ${sign(delta(h.total, stats(r.cold.nativeCreate)))} |`,
    );
    lines.push(
      `| ${r.name} | cold create → first exec | ${fmt(stats(r.cold.sdk))} | | | | ${fmt(stats(r.cold.native))} | ${sign(delta(stats(r.cold.sdk), stats(r.cold.native)))} |`,
    );
    lines.push(
      `| ${r.name} | init (fresh process) | ${fmt(stats(r.init.sdk))} | | | | ${fmt(stats(r.init.baseline))} | ${sign(delta(stats(r.init.sdk), stats(r.init.baseline)))} |`,
    );
    lines.push(
      `| ${r.name} | handle (create→handle) | ${fmt(h.total)} | ${fmt(h.create)} | ${sign(h.handle?.median ?? null)} | | | |`,
    );

    for (const [op, o] of Object.entries(r.ops))
      lines.push(
        `| ${r.name} | ${op}${o.errors.length ? " ⚠" : ""} | ${fmt(o.sdk)} | ${fmt(o.adapter)} | ${sign(o.overVsAdapterMs)} | ${fmt(o.sdkWithFloor)} | ${fmt(o.floor)} | ${sign(o.overVsFloorMs)} |`,
      );
    lines.push(
      `| ${r.name} | cleanup SDK / native | ${r.leftover ?? "unknown"} / ${r.nativeLeftover ?? "unknown"} | | | | | |`,
    );

    if (r.error) lines.push(`| ${r.name} | error | ${r.error.replaceAll("|", "/")} | | | | | |`);
  }

  const notes = reports.flatMap((r) =>
    Object.entries(r.ops).flatMap(([op, o]) => o.errors.map((e) => `- ${r.name} ${op}: ${e}`)),
  );

  return [...lines, ...(notes.length ? ["", "Errors:", ...notes] : [])].join("\n");
}

const startedAt = new Date().toISOString();
const reports: ProviderReport[] = [];

for (const name of values.providers
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)) {
  console.error(`[${name}] measuring`);
  reports.push(await measureProvider(name));
  const last = reports.at(-1);

  if (values.out)
    await writeFile(
      values.out,
      `${JSON.stringify({ runId, sdkRoot, sdkCommit: sdkCommit(), startedAt, n, sandboxesPerProvider: sandboxCount, templates: Object.fromEntries(templates), providers: reports }, null, 2)}\n`,
    );
  console.error(
    `[${name}] done${last?.error ? ` with error: ${last.error}` : ""}; leftover SDK/native ${last?.leftover ?? "unknown"}/${last?.nativeLeftover ?? "unknown"}`,
  );

  if (last?.leftover !== 0 || last.nativeLeftover !== 0) break;
}

const output = {
  runId,
  sdkRoot,
  sdkCommit: sdkCommit(),
  startedAt,
  finishedAt: new Date().toISOString(),
  n,
  sandboxesPerProvider: sandboxCount,
  templates: Object.fromEntries(templates),
  providers: reports,
};

if (values.out) await writeFile(values.out, `${JSON.stringify(output, null, 2)}\n`);

console.log(markdown(reports));

if (
  reports.some(
    (r) =>
      r.error ||
      r.leftover !== 0 ||
      r.nativeLeftover !== 0 ||
      Object.values(r.ops).some((o) => o.errors.length),
  )
)
  process.exitCode = 1;

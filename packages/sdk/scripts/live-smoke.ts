// Cross-provider live smoke (SBX-69). One small sandbox per provider:
// create, run, file round-trip, streamed run, preview URL, destroy, then a
// leak check scoped to this run's unique label. See LIVE_SMOKE.md for usage.
//
//   bun scripts/live-smoke.ts [--providers e2b,daytona] [--concurrency 4] [--timeout-ms 120000] [--json out.json]
//
// Without --providers it runs every registered provider whose credentials are
// in the environment. Load keys into the process env; this script never prints them.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createSandbox, listSandboxes, reapSandboxes, SandboxError } from "../src/index.js";
import type { Provider } from "../src/provider.js";
import type { SandboxBase } from "../src/types.js";

interface ProviderSpec {
  /** Every group lists alternatives; each group must have one variable set. */
  env: ReadonlyArray<readonly [string, ...string[]]>;
  load: () => Promise<Provider>;
  /** Ports declared at creation, for providers that only preview declared ports. */
  ports?: number[];
}

// To add a provider (for example Sandboxer), add one entry here.
const registry = {
  memory: { env: [], load: async () => (await import("../src/memory.js")).memory() },
  local: { env: [], load: async () => (await import("../src/providers/local/index.js")).local() },
  agentos: {
    env: [],
    load: async () => (await import("../src/providers/agentos/index.js")).agentos(),
  },
  e2b: {
    env: [["E2B_API_KEY"]],
    load: async () => (await import("../src/providers/e2b/index.js")).e2b(),
  },
  daytona: {
    env: [["DAYTONA_API_KEY"]],
    load: async () => (await import("../src/providers/daytona/index.js")).daytona(),
  },
  vercel: {
    env: [["VERCEL_OIDC_TOKEN", "VERCEL_TOKEN"]],
    load: async () => (await import("../src/providers/vercel/index.js")).vercel(),
    ports: [3000],
  },
  upstash: {
    env: [["UPSTASH_BOX_API_KEY"]],
    load: async () => (await import("../src/providers/upstash/index.js")).upstash(),
  },
  railway: {
    env: [["RAILWAY_API_TOKEN"], ["RAILWAY_ENVIRONMENT_ID"]],
    load: async () => (await import("../src/providers/railway/index.js")).railway(),
    ports: [3000],
  },
  boat: {
    env: [["BOAT_API_KEY"]],
    load: async () => (await import("../src/providers/boat/index.js")).boat(),
  },
  tenki: {
    env: [["TENKI_API_KEY", "TENKI_AUTH_TOKEN"]],
    load: async () => (await import("../src/providers/tenki/index.js")).tenki(),
  },
  boxd: {
    env: [["BOXD_API_KEY"]],
    load: async () => (await import("../src/providers/boxd/index.js")).boxd(),
  },
  freestyle: {
    env: [["FREESTYLE_API_KEY"]],
    load: async () => (await import("../src/providers/freestyle/index.js")).freestyle(),
  },
  // The default superserve/node-22 template has no python3; set SANDBOX_SUPERSERVE_TEMPLATE to one that does.
  superserve: {
    env: [["SUPERSERVE_API_KEY"]],
    load: async () =>
      (await import("../src/providers/superserve/index.js")).superserve({
        template: process.env.SANDBOX_SUPERSERVE_TEMPLATE,
      }),
  },
  sandboxer: {
    env: [["SANDBOXER_API_KEY"]],
    load: async () => (await import("../src/providers/sandboxer/index.js")).sandboxer(),
  },
} satisfies Record<string, ProviderSpec>;

type ProviderName = keyof typeof registry;

function isProviderName(name: string): name is ProviderName {
  return Object.hasOwn(registry, name);
}

function hasCredentials(spec: ProviderSpec) {
  return spec.env.every((group) => group.some((name) => Boolean(process.env[name])));
}

type Outcome = { kind: "pass" } | { kind: "fail"; step: string; message: string };

interface ProviderResult {
  provider: ProviderName;
  outcome: Outcome;
  createMs?: number;
  firstRunMs?: number;
  sandboxId?: string;
  notes: string[];
}

interface LeakResult {
  provider: ProviderName;
  remainingBeforeReap: number;
  reaped: number;
  remaining: number;
  error?: string;
}

const { values } = parseArgs({
  options: {
    providers: { type: "string" },
    concurrency: { type: "string", default: "4" },
    "timeout-ms": { type: "string", default: "120000" },
    json: { type: "string" },
  },
});

const concurrency = Math.min(4, Math.max(1, Number(values.concurrency)));
const timeoutMs = Number(values["timeout-ms"]);

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
  throw new Error("--timeout-ms must be a positive number");

const requested = values.providers
  ?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const unknown = requested?.filter((name) => !isProviderName(name)) ?? [];

if (unknown.length)
  throw new Error(
    `Unknown providers: ${unknown.join(", ")}. Known: ${Object.keys(registry).join(", ")}`,
  );

const candidates = (requested ?? Object.keys(registry)).filter(isProviderName);
const selected = candidates.filter((name) => hasCredentials(registry[name]));
const missing = candidates.filter((name) => !selected.includes(name));

const runId = `sbx69-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
const runLabels = { "smoke-run": runId };

// One instance per provider, so the leak check sees in-process state (memory, local).
const loaded = new Map<ProviderName, Promise<Provider>>();

function load(name: ProviderName) {
  let provider = loaded.get(name);

  if (!provider) {
    provider = registry[name].load();
    loaded.set(name, provider);
  }

  return provider;
}

function message(error: unknown) {
  if (error instanceof SandboxError) return `${error.code}: ${error.message}`;

  return error instanceof Error ? error.message : String(error);
}

async function timed<T>(work: () => PromiseLike<T>) {
  const start = performance.now();
  const value = await work();

  return { value, ms: Math.round(performance.now() - start) };
}

function expectEqual(step: string, actual: string, expected: string) {
  if (actual !== expected)
    throw new SmokeFailure(
      step,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual.slice(0, 200))}`,
    );
}

class SmokeFailure extends Error {
  constructor(
    readonly step: string,
    detail: string,
  ) {
    super(detail);
  }
}

async function smoke(name: ProviderName, signal: AbortSignal): Promise<ProviderResult> {
  const spec: ProviderSpec = registry[name];
  const result: ProviderResult = { provider: name, outcome: { kind: "pass" }, notes: [] };
  let step = "load";
  let box: SandboxBase<unknown> | undefined;

  try {
    const provider = await load(name);
    step = "create";

    const created = await timed(() =>
      createSandbox(provider, { labels: runLabels, ports: spec.ports, signal }),
    );

    const sandbox = created.value;
    box = sandbox;
    result.createMs = created.ms;
    result.sandboxId = sandbox.id;

    step = "run";
    const first = await timed(() => sandbox.run("echo ok"));
    result.firstRunMs = first.ms;

    if (!first.value.ok)
      throw new SmokeFailure(
        step,
        `exit ${first.value.exitCode}: ${first.value.stderr.slice(0, 200)}`,
      );
    expectEqual(step, first.value.stdout, "ok\n");

    step = "files";
    const content = `smoke ${runId}\n`;
    await box.files.write("smoke/hello.txt", content);
    expectEqual(step, await box.files.read("smoke/hello.txt"), content);

    step = "stream";
    const handle = box.run("printf 'one\\n'; sleep 0.3; printf 'two\\n'");
    let streamed = "";
    let chunks = 0;

    for await (const chunk of handle)
      if (chunk.stream === "stdout") {
        streamed += chunk.text;
        chunks++;
      }

    expectEqual(step, streamed, "one\ntwo\n");
    expectEqual(step, (await handle).stdout, "one\ntwo\n");
    result.notes.push(`stream ${chunks} chunk${chunks === 1 ? "" : "s"}`);

    step = "preview";

    try {
      const preview = await box.preview(3000);
      const protocol = new URL(preview.url).protocol;

      if (protocol !== "https:" && protocol !== "http:")
        throw new SmokeFailure(step, `unexpected protocol ${protocol}`);
      result.notes.push(`preview ${protocol.slice(0, -1)}`);
    } catch (error) {
      if (!(error instanceof SandboxError && error.code === "unsupported")) throw error;
      result.notes.push("preview unsupported");
    }
  } catch (error) {
    result.outcome = {
      kind: "fail",
      step: error instanceof SmokeFailure ? error.step : step,
      message: message(error),
    };
  } finally {
    if (box) {
      try {
        await box.destroy();
      } catch (error) {
        result.notes.push(`destroy failed: ${message(error)}`);

        if (result.outcome.kind === "pass")
          result.outcome = { kind: "fail", step: "destroy", message: message(error) };
      }
    }
  }

  return result;
}

async function bounded(name: ProviderName): Promise<ProviderResult> {
  const controller = new AbortController();
  const work = smoke(name, controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const first = await Promise.race([work, deadline]);
  clearTimeout(timer);

  if (first !== "timeout") return first;
  // Abort creation; a late sandbox is destroyed by createSandbox. Give an
  // in-flight step a short grace so its finally can destroy the sandbox.
  controller.abort();

  const late = await Promise.race([
    work,
    new Promise<undefined>((resolve) => setTimeout(resolve, 60_000)),
  ]);

  return {
    ...(late ?? { provider: name, notes: [] }),
    outcome: { kind: "fail", step: "timeout", message: `exceeded ${timeoutMs} ms` },
  };
}

async function pool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>) {
  const results: R[] = [];
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

async function leakCheck(name: ProviderName): Promise<LeakResult> {
  const result: LeakResult = { provider: name, remainingBeforeReap: 0, reaped: 0, remaining: 0 };

  try {
    const provider = await load(name);

    // listSandboxes filters SDK-owned boxes; provider.list is the adapter's
    // native label query. Count the union so neither path hides a leak.
    const count = async () => {
      const [sdk, native] = await Promise.all([
        listSandboxes(provider, { labels: runLabels }),
        provider.list(runLabels),
      ]);

      return new Set(
        [...sdk, ...native]
          .filter((info) => info.labels["smoke-run"] === runId)
          .map((info) => info.id),
      ).size;
    };

    result.remainingBeforeReap = await count();

    if (result.remainingBeforeReap > 0) {
      result.reaped = await reapSandboxes(provider, { labels: runLabels });

      // List indexes can lag a delete; poll briefly before calling it a leak.
      for (let attempt = 0; attempt < 10; attempt++) {
        result.remaining = await count();

        if (result.remaining === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  } catch (error) {
    result.error = message(error);
    result.remaining = -1;
  }

  return result;
}

console.error(
  `live smoke ${runId}: ${selected.join(", ") || "(none)"}${missing.length ? `; no credentials: ${missing.join(", ")}` : ""}`,
);

const results = await pool(selected, concurrency, bounded);
const leaks = await pool(selected, concurrency, leakCheck);

const rows = results.map((result) => {
  const outcome = result.outcome.kind === "pass" ? "PASS" : `FAIL (${result.outcome.step})`;

  const note = [
    ...result.notes,
    ...(result.outcome.kind === "fail" ? [result.outcome.message] : []),
  ]
    .join("; ")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");

  return `| ${result.provider} | ${outcome} | ${result.createMs ?? "-"} | ${result.firstRunMs ?? "-"} | ${note} |`;
});

for (const name of missing)
  rows.push(
    `| ${name} | SKIP | - | - | no credentials (${registry[name].env.map((group) => group.join(" or ")).join(" + ")}) |`,
  );

console.log(
  [
    "| Provider | Result | Create ms | First run ms | Note |",
    "| --- | --- | ---: | ---: | --- |",
    ...rows,
  ].join("\n"),
);

console.log("");

console.log(
  [
    "| Provider | Listed after run | Reaped | Remaining |",
    "| --- | ---: | ---: | ---: |",
    ...leaks.map(
      (leak) =>
        `| ${leak.provider} | ${leak.remainingBeforeReap} | ${leak.reaped} | ${leak.error ? `error: ${leak.error}` : leak.remaining} |`,
    ),
  ].join("\n"),
);

if (values.json)
  await writeFile(
    values.json,
    JSON.stringify({ runId, date: new Date().toISOString(), results, leaks, missing }, null, 2),
  );

const failed =
  results.some((result) => result.outcome.kind === "fail") ||
  leaks.some((leak) => leak.remaining !== 0);

process.exit(failed ? 1 : 0);

/**
 * Checks the tables in content/reference/capabilities.mdx against the SDK source.
 *
 *   bun scripts/check-capabilities.ts
 *
 * Every provider is built from its adapter with dummy credentials and a stub transport:
 * the peer SDK loader, `fetch` (the providers that call their HTTP API directly), or a Docker
 * socket (Local) records the
 * call and fails it. Nothing leaves this machine. A cell is checked in one of two ways:
 *
 * - declared: against what the adapter declares as data (`capabilities`, `keyMode`, `previewMode`).
 * - probed: `createSandbox` runs with one option. "rejects" means it threw `unsupported`
 *   before the transport was called. "accepts" means the transport was called, so neither
 *   the SDK nor the adapter refused it. The provider's own API can still refuse it later.
 *
 * Details that only a live provider can show are printed as "not checked".
 * The peer packages table is checked against the `import()` calls each provider subpath
 * reaches in packages/sdk/src, and against packages/sdk/package.json.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  createSandbox,
  SandboxError,
  type CreateOptions,
} from "../../../packages/sdk/src/index.ts";
import { memory } from "../../../packages/sdk/src/memory.ts";
import type { Capability, Provider } from "../../../packages/sdk/src/provider.ts";
import {
  createAgentosProvider,
  createRegistry,
} from "../../../packages/sdk/src/providers/agentos/provider.ts";
import { boat } from "../../../packages/sdk/src/providers/boat/index.ts";
import { createBoxdProvider } from "../../../packages/sdk/src/providers/boxd/provider.ts";
import { daytona } from "../../../packages/sdk/src/providers/daytona/index.ts";
import { e2b } from "../../../packages/sdk/src/providers/e2b/index.ts";
import { freestyle } from "../../../packages/sdk/src/providers/freestyle/index.ts";
import { local } from "../../../packages/sdk/src/providers/local/index.ts";
import { createRailwayProvider } from "../../../packages/sdk/src/providers/railway/provider.ts";
import { sandboxer } from "../../../packages/sdk/src/providers/sandboxer/index.ts";
import { superserve } from "../../../packages/sdk/src/providers/superserve/index.ts";
import { createTenkiProvider } from "../../../packages/sdk/src/providers/tenki/provider.ts";
import { createUpstashProvider } from "../../../packages/sdk/src/providers/upstash/provider.ts";
import { createVercelProvider } from "../../../packages/sdk/src/providers/vercel/provider.ts";

const docsDir = resolve(import.meta.dirname, "..");
const sdkDir = resolve(docsDir, "../../packages/sdk");
const page = join(docsDir, "content", "reference", "capabilities.mdx");
const pageLabel = "content/reference/capabilities.mdx";
const offlineKey = "offline-check";

let transportCalls = 0;

/** Stands in for a provider SDK import. The probe only needs to know it was reached. */
async function stubTransport(): Promise<never> {
  transportCalls += 1;
  throw new Error("Offline check: the provider transport is stubbed");
}

const realFetch = globalThis.fetch;

/** E2B, Daytona, Freestyle, Superserve, Boat and Sandboxer reach their API through the global
 * fetch, so it stands in for them. */
const stubFetch: typeof fetch = async () => {
  transportCalls += 1;

  return new Response('{"message":"offline check"}', { status: 401 });
};

globalThis.fetch = stubFetch;

const socketDir = mkdtempSync(join(tmpdir(), "sandbox-sdk-capabilities-"));
const dockerSocket = join(socketDir, "docker.sock");

const docker = createServer((socket) => {
  transportCalls += 1;
  socket.destroy();
});

await new Promise<void>((done) => docker.listen(dockerSocket, done));

/** A matrix column and a way to build a fresh adapter for it. Adapters cache a failed SDK
 * load, so every probe gets its own instance. */
interface Subject {
  readonly column: string;
  build(): Provider;
}

const subjects: readonly Subject[] = [
  { column: "Local", build: () => local({ dockerHost: `unix://${dockerSocket}` }) },
  {
    column: "agentOS",
    build: () => createAgentosProvider({}, stubTransport, createRegistry()),
  },
  { column: "E2B", build: () => e2b({ apiKey: offlineKey }) },
  {
    column: "Vercel",
    build: () =>
      createVercelProvider(stubTransport, {
        token: offlineKey,
        teamId: offlineKey,
        projectId: offlineKey,
      }),
  },
  {
    column: "Daytona",
    build: () => daytona({ apiKey: offlineKey }),
  },
  {
    column: "Upstash",
    build: () => createUpstashProvider({ apiKey: offlineKey }, stubTransport),
  },
  {
    column: "Railway",
    build: () =>
      createRailwayProvider({ token: offlineKey, environmentId: offlineKey }, stubTransport),
  },
  { column: "Boat", build: () => boat({ apiKey: offlineKey }) },
  { column: "Sandboxer", build: () => sandboxer({ apiKey: offlineKey }) },
  { column: "Tenki", build: () => createTenkiProvider({ apiKey: offlineKey }, stubTransport) },
  {
    column: "Superserve",
    build: () => superserve({ apiKey: offlineKey }),
  },
  {
    column: "boxd",
    build: () => createBoxdProvider({ apiKey: offlineKey }, stubTransport, stubTransfers),
  },
  {
    column: "Freestyle",
    build: () => freestyle({ apiKey: offlineKey }),
  },
  { column: "Memory", build: () => memory() },
];

function stubTransfers(): never {
  transportCalls += 1;
  throw new Error("Offline check: boxd file transfers are stubbed");
}

type Outcome = "accepts" | "rejects";

/** One claim a cell makes about its provider. */
type Check =
  | { readonly kind: "declared"; readonly claim: string; holds(provider: Provider): boolean }
  | { readonly kind: "probe"; readonly options: CreateOptions; readonly expect: Outcome };

interface Row {
  readonly label: string;
  /** Each allowed cell value and the checks it implies. A value with no checks is not checked. */
  readonly cells: Readonly<Record<string, readonly Check[]>>;
  /** What the checks above cannot show, printed as "not checked". */
  readonly unchecked?: string;
}

function declared(claim: string, holds: (provider: Provider) => boolean): Check {
  return { kind: "declared", claim, holds };
}

function accepts(options: CreateOptions): Check {
  return { kind: "probe", options, expect: "accepts" };
}

function rejects(options: CreateOptions): Check {
  return { kind: "probe", options, expect: "rejects" };
}

function capability(name: Capability) {
  return {
    present: [declared(`the "${name}" capability`, (provider) => provider.capabilities.has(name))],
    absent: [declared(`no "${name}" capability`, (provider) => !provider.capabilities.has(name))],
  };
}

/** Distinct preview ports 3000, 3001, and so on. */
function ports(count: number) {
  return Array.from({ length: count }, (_, index) => 3000 + index);
}

/** Short labels app-0, app-1, and so on. */
function labels(count: number) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`app-${index}`, "1"]));
}

/** A label value that compresses poorly, so a compressed metadata budget can't absorb it. */
function noise(length: number) {
  let text = "";
  let seed = 7;

  while (text.length < length) {
    seed = (seed * 48_271) % 2_147_483_647;
    text += seed.toString(36);
  }

  return text.slice(0, length);
}

const pause = capability("pause");
const snapshot = capability("snapshot");
const terminal = capability("terminal");
const tenMinutes = 10 * 60_000;
const allowHost = { allow: ["example.com"] };

const rows: readonly Row[] = [
  {
    label: "pause()",
    cells: { Yes: pause.present, Partial: pause.present, No: pause.absent },
    unchecked: "what survives a pause (the Partial cells and the Pause note)",
  },
  {
    label: "snapshot()",
    cells: { Yes: snapshot.present, "Files only": snapshot.present, No: snapshot.absent },
    unchecked: 'what a snapshot holds ("Files only")',
  },
  { label: "terminal()", cells: { Yes: terminal.present, No: terminal.absent } },
  {
    label: "No network",
    cells: {
      Yes: [accepts({ network: "none" })],
      Recorded: [accepts({ network: "none" })],
      No: [rejects({ network: "none" })],
    },
    unchecked: "whether the provider enforces the policy once the sandbox runs",
  },
  {
    label: "Allow list",
    cells: {
      Yes: [accepts({ network: allowHost })],
      Recorded: [accepts({ network: allowHost })],
      "Literal hosts": [
        accepts({ network: allowHost }),
        rejects({ network: { allow: ["*.example.com"] } }),
      ],
      "Empty only": [accepts({ network: { allow: [] } }), rejects({ network: allowHost })],
      No: [rejects({ network: allowHost })],
    },
    unchecked: "which wildcard, IP, and CIDR entries each provider takes (the Network note)",
  },
  {
    label: "Size presets",
    cells: { Yes: [accepts({ size: "small" })], No: [rejects({ size: "small" })] },
    unchecked: "the machine each preset maps to",
  },
  {
    label: "Exact size",
    cells: {
      Yes: [accepts({ size: { cpu: 2, memoryMb: 4096, diskGb: 20 } })],
      "No disk": [
        accepts({ size: { cpu: 2, memoryMb: 4096 } }),
        rejects({ size: { cpu: 2, memoryMb: 4096, diskGb: 20 } }),
      ],
      "vCPUs only": [
        accepts({ size: { cpu: 2, memoryMb: 4096 } }),
        rejects({ size: { cpu: 2, memoryMb: 3072 } }),
        rejects({ size: { cpu: 2, memoryMb: 4096, diskGb: 20 } }),
      ],
      "Fixed steps": [
        accepts({ size: { cpu: 2, memoryMb: 8192 } }),
        rejects({ size: { cpu: 3, memoryMb: 12_288 } }),
      ],
      No: [
        rejects({ size: { cpu: 2, memoryMb: 4096 } }),
        rejects({ size: { cpu: 2, memoryMb: 4096, diskGb: 20 } }),
      ],
    },
  },
  {
    label: "idleTimeoutMs",
    cells: {
      Yes: [accepts({ idleTimeoutMs: tenMinutes })],
      Partial: [accepts({ idleTimeoutMs: tenMinutes })],
      Minutes: [accepts({ idleTimeoutMs: tenMinutes })],
      Seconds: [accepts({ idleTimeoutMs: tenMinutes })],
      No: [rejects({ idleTimeoutMs: tenMinutes })],
    },
    unchecked: 'the rounding units ("Minutes", "Seconds") and what the provider does when it fires',
  },
  {
    label: "timeoutMs",
    cells: {
      Yes: [accepts({ timeoutMs: tenMinutes })],
      Partial: [accepts({ timeoutMs: tenMinutes })],
      Minutes: [accepts({ timeoutMs: tenMinutes })],
      Seconds: [accepts({ timeoutMs: tenMinutes })],
      "Per session": [accepts({ timeoutMs: tenMinutes })],
      No: [rejects({ timeoutMs: tenMinutes })],
    },
    unchecked: 'the rounding units ("Minutes", "Seconds") and "Per session"',
  },
  {
    label: "ports",
    cells: {
      Yes: [accepts({ ports: [3000] })],
      No: [accepts({ ports: [3000] })],
      "Up to 10": [accepts({ ports: ports(10) }), rejects({ ports: ports(11) })],
      "Up to 15": [accepts({ ports: ports(15) }), rejects({ ports: ports(16) })],
    },
    unchecked: "whether a preview port must be declared (Yes or No cells)",
  },
  {
    label: "labels",
    cells: {
      Yes: [accepts({ labels: labels(5) }), accepts({ labels: { app: noise(4000) } })],
      "Up to 4": [accepts({ labels: labels(4) }), rejects({ labels: labels(5) })],
      "120 chars": [accepts({ labels: labels(1) }), rejects({ labels: { app: noise(400) } })],
      "About 2.9 KB": [
        accepts({ labels: { app: noise(2000) } }),
        rejects({ labels: { app: noise(4000) } }),
      ],
    },
  },
  {
    label: "Key mode",
    cells: {
      exact: [declared('keyMode "exact"', (provider) => provider.keyMode === "exact")],
      "best-effort": [
        declared('keyMode "best-effort"', (provider) => provider.keyMode === "best-effort"),
      ],
    },
  },
  {
    label: "Preview URL",
    cells: {
      Fake: [declared('previewMode "placeholder"', (p) => p.previewMode === "placeholder")],
      Localhost: [],
      Public: [],
      "Token header": [],
      "Bearer header": [],
      "Cookie header": [],
      No: [],
    },
    unchecked: "every Preview URL cell except Fake needs a live provider",
  },
];

const source = readFileSync(page, "utf8");
const failures: string[] = [];
const notChecked: string[] = [];
let passed = 0;

/** A Markdown table: header cells, then body rows, with `&nbsp;`, backticks, and links removed. */
interface Table {
  readonly header: readonly string[];
  readonly body: readonly (readonly string[])[];
}

function plain(cell: string) {
  return cell
    .replaceAll("&nbsp;", " ")
    .replaceAll("`", "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/** The first table after the `## <heading>` line, or a failure when there is none. */
function tableAfter(markdown: string, heading: string): Table | undefined {
  const lines = markdown.split("\n");
  const start = lines.indexOf(`## ${heading}`);

  if (start === -1) {
    failures.push(`${pageLabel} has no "## ${heading}" section`);

    return undefined;
  }

  const first = lines.findIndex((line, index) => index > start && line.startsWith("|"));
  const end = lines.findIndex((line, index) => index > first && !line.startsWith("|"));
  const rowsText = lines.slice(first, end === -1 ? undefined : end);
  const cells = rowsText.map((line) => line.slice(1, -1).split("|").map(plain));
  const [header, , ...body] = cells;

  if (first === -1 || header === undefined) {
    failures.push(`${pageLabel} has no table under "## ${heading}"`);

    return undefined;
  }

  return { header, body };
}

async function probe(subject: Subject, options: CreateOptions): Promise<Outcome> {
  const before = transportCalls;

  try {
    const box = await createSandbox(subject.build(), options);
    await box.destroy();

    return "accepts";
  } catch (error) {
    if (transportCalls > before) return "accepts";

    if (error instanceof SandboxError && error.code === "unsupported") return "rejects";
    throw new Error(
      `${subject.column}: probing ${describe(options)} failed before the transport, so the check can't tell: ${String(error)}`,
      { cause: error },
    );
  }
}

/** Probe options, cut short enough to read in a failure line. */
function describe(options: CreateOptions) {
  const text = JSON.stringify(options);

  return text.length > 100 ? `${text.slice(0, 100)}...` : text;
}

async function checkMatrix() {
  const matrix = tableAfter(source, "Matrix");

  if (!matrix) return;
  const columns = matrix.header.slice(1);
  const known = new Set(subjects.map((subject) => subject.column));

  for (const column of columns)
    if (!known.has(column))
      failures.push(`Matrix column "${column}" is not a provider this script builds`);

  for (const subject of subjects)
    if (!columns.includes(subject.column))
      failures.push(`Matrix has no column for ${subject.column}`);

  const labelsInPage = new Set(matrix.body.map((cells) => cells[0]));

  for (const row of rows)
    if (!labelsInPage.has(row.label)) failures.push(`Matrix has no "${row.label}" row`);

  for (const cells of matrix.body) {
    const [label = "", ...values] = cells;
    const row = rows.find((candidate) => candidate.label === label);

    if (!row) {
      failures.push(`Matrix row "${label}" has no check. Add one to scripts/check-capabilities.ts`);
      continue;
    }

    if (row.unchecked) notChecked.push(`${row.label}: ${row.unchecked}`);

    for (const [index, value] of values.entries()) {
      const column = columns[index];
      const subject = subjects.find((candidate) => candidate.column === column);

      if (!subject) continue;
      const checks = row.cells[value];

      if (checks === undefined) {
        failures.push(
          `${label} / ${column}: "${value}" is not a known value. Use one of: ${Object.keys(row.cells).join(", ")}`,
        );
        continue;
      }

      if (checks.length === 0) continue;
      const provider = subject.build();

      for (const check of checks) {
        if (check.kind === "declared") {
          if (check.holds(provider)) passed += 1;
          else
            failures.push(
              `${label} / ${column}: the page says "${value}", so the adapter should declare ${check.claim}, but it doesn't`,
            );
          continue;
        }

        const outcome = await probe(subject, check.options);

        if (outcome === check.expect) passed += 1;
        else
          failures.push(
            `${label} / ${column}: the page says "${value}", so createSandbox should ${check.expect === "accepts" ? "accept" : "reject"} ${describe(check.options)}, but it ${outcome === "accepts" ? "accepted it" : "threw unsupported"}`,
          );
      }
    }
  }
}

/** The parts of packages/sdk/package.json this check reads. Each export becomes the built file it
 * points to: `./package.json` is a plain path, and every other subpath has a `default` condition. */
const manifestSchema = z.object({
  exports: z.record(
    z.string(),
    z.union([z.string(), z.object({ default: z.string() }).transform((target) => target.default)]),
  ),
  peerDependencies: z.record(z.string(), z.string()),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })),
});

/** The package a bare specifier belongs to: `@boxd-sh/sdk/web` is `@boxd-sh/sdk`. */
function packageOf(specifier: string) {
  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** Packages loaded with `import("...")` from `entry` and every source file it imports. */
function dynamicImports(entry: string) {
  const seen = new Set<string>();
  const found = new Set<string>();
  const pending = [entry];

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    // JSDoc examples (`box.native.sdk(() => import("e2b"))`) are not imports, so comments are dropped.
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    for (const [, specifier = ""] of text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g))
      // Error messages quote `import("${pkg}")` in template literals; a placeholder is never a module.
      if (!specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.includes("${"))
        found.add(packageOf(specifier));

    for (const [, relative = ""] of text.matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+)\.js"/g))
      pending.push(join(dirname(file), `${relative}.ts`));
  }

  return found;
}

function checkPackages() {
  const manifest = manifestSchema.parse(
    JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")),
  );

  const table = tableAfter(source, "Peer packages");

  if (!table) return;
  const at = (name: string) => table.header.indexOf(name);
  const columns = [at("Provider"), at("Import"), at("Peer package"), at("Version")];

  if (columns.includes(-1)) {
    failures.push(
      'Peer packages needs the columns "Provider", "Import", "Peer package", and "Version"',
    );

    return;
  }

  const listed = new Set<string>();

  for (const cells of table.body) {
    const [name = "", subpath = "", peer = "", version = ""] = columns.map((index) => cells[index]);
    const subject = subjects.find((candidate) => candidate.column === name);
    listed.add(name);

    if (!subject) {
      failures.push(`Peer packages row "${name}" is not a provider this script builds`);
      continue;
    }

    const subpathName = subject.build().name;
    const target = manifest.exports[`./${subpathName}`];

    if (subpath !== `@opencoredev/sandbox-sdk/${subpathName}` || target === undefined) {
      failures.push(
        `Peer packages / ${name}: import should be @opencoredev/sandbox-sdk/${subpathName}, found "${subpath}"`,
      );
      continue;
    }

    const entry = join(sdkDir, target.replace("./dist/", "src/").replace(/\.js$/, ".ts"));
    const loads = [...dynamicImports(entry)].sort();
    const expected = loads.length === 0 ? "None" : loads.join(", ");

    if (peer !== expected) {
      failures.push(
        `Peer packages / ${name}: the adapter loads ${expected}, the page says "${peer}"`,
      );
      continue;
    }

    passed += 1;
    const ranges = loads.map((pkg) => manifest.peerDependencies[pkg]);

    for (const pkg of loads)
      if (manifest.peerDependenciesMeta[pkg]?.optional !== true)
        failures.push(
          `Peer packages / ${name}: ${pkg} is not an optional peer in packages/sdk/package.json`,
        );

    const range = loads.length === 0 ? "None" : ranges.join(", ");

    if (version === range) passed += 1;
    else
      failures.push(
        `Peer packages / ${name}: package.json pins ${range}, the page says "${version}"`,
      );
  }

  for (const subject of subjects)
    if (!listed.has(subject.column))
      failures.push(`Peer packages has no row for ${subject.column}`);
}

try {
  await checkMatrix();
  checkPackages();
} finally {
  globalThis.fetch = realFetch;
  docker.close();
  rmSync(socketDir, { recursive: true, force: true });
}

for (const line of notChecked) console.log(`not checked: ${line}`);

if (failures.length > 0) {
  console.error(`\ncapabilities: ${failures.length} mismatch(es) in ${pageLabel}:`);

  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`\ncapabilities: ${passed} checks passed against the SDK source`);

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { command } from "../workloads.js";
import type { ExpandedScenario, VerifyResult } from "./types.js";
import {
  decode,
  hexDigest,
  memo,
  outcomeOf,
  positiveSeconds,
  rng32,
  rngSource,
  secondsSince,
  seedField,
  sha256Hex,
  tapCounts,
  wrongSeed,
  writeTree,
  type ProjectEdit,
} from "./verify-kit.js";

/**
 * Agent task scenarios: the file and command sequence a coding agent runs to fix a bug, apply a
 * codemod, or triage logs. Each run builds a fresh seeded project, times the whole task on the
 * host, and checks the guest's final digest against one the host derives from the seed.
 */

/** Write `files` (paths relative to `root`) after clearing `root`. */
async function freshProject(
  box: Sandbox,
  root: string,
  files: Readonly<Record<string, string>>,
  timeoutMs: number,
) {
  await command(box, `rm -rf ${root} && mkdir -p ${root}`, timeoutMs);
  await box.files.write(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [`${root}/${path}`, text])),
  );
}

/** The last stdout line of a guest command, decoded with `schema`, or an error. */
function lastLine<T>(schema: z.ZodType<T>, stdout: string, what: string): T {
  const reply = decode(schema, stdout.split("\n").at(-1) ?? "");

  if (!reply.ok) throw new Error(`${what}: ${reply.reason}`);

  return reply.data;
}

// ---------------------------------------------------------------------------------------------
// agent-fix-bug-node
// ---------------------------------------------------------------------------------------------

const nodeRoot = "/workspace/bench-agent-node";
const nodeTestCommand = `cd ${nodeRoot} && node --test --test-reporter=tap test/money.test.js test/cart.test.js`;

/** Tests in the Node project, and how many the two seeded bugs break. */
export const nodeTestCount = 5;
export const nodeFailingBefore = 3;

interface CartLine {
  readonly price: string;
  readonly qty: number;
}

interface Cart {
  readonly lines: readonly CartLine[];
  readonly taxBasisPoints: number;
}

interface CartTotal {
  readonly subtotal: number;
  readonly tax: number;
  readonly total: number;
}

/** A price string and its exact value in cents. `minWhole` keeps a line from pricing at zero. */
interface Amount {
  readonly text: string;
  readonly cents: number;
}

function seededAmount(next: () => number, minWhole: number): Amount {
  const whole = minWhole + (next() % (500 - minWhole));
  const frac = next() % 100;

  return { text: `${whole}.${String(frac).padStart(2, "0")}`, cents: whole * 100 + frac };
}

function centsOf(price: string): number {
  const [whole = "0", frac = "0"] = price.split(".");

  return Number(whole) * 100 + Number(frac);
}

/** The fixed `cartTotal`, as the host computes it. */
function cartTotal(cart: Cart): CartTotal {
  let subtotal = 0;

  for (const line of cart.lines) subtotal += centsOf(line.price) * line.qty;

  const tax = Math.round((subtotal * cart.taxBasisPoints) / 10_000);

  return { subtotal, tax, total: subtotal + tax };
}

function seededCart(next: () => number): Cart {
  const lines: CartLine[] = [];
  const count = 2 + (next() % 5);

  for (let i = 0; i < count; i++)
    lines.push({ price: seededAmount(next, 1).text, qty: 1 + (next() % 9) });

  return { lines, taxBasisPoints: next() % 2500 };
}

interface NodeFixture {
  readonly amounts: readonly Amount[];
  readonly testCart: Cart;
  readonly carts: readonly Cart[];
}

const nodeFixture = memo((seed: number): NodeFixture => {
  const next = rng32(seed ^ 0xb06);
  const amounts = Array.from({ length: 12 }, () => seededAmount(next, 0));
  const testCart = seededCart(next);
  const carts = Array.from({ length: 48 }, () => seededCart(next));

  return { amounts, testCart, carts };
});

/** The seeded Node ESM project, with two bugs: a floor that drops a cent and a loop that skips the first line. */
export function nodeProjectFiles(seed: number) {
  const fixture = nodeFixture(seed);
  const cases = fixture.amounts.map((a) => [a.text, a.cents]);

  return {
    "package.json": `${JSON.stringify({ name: "bench-agent-node", private: true, type: "module" }, null, 2)}\n`,
    "src/money.js": `/** Parse a decimal price such as "12.34" into integer cents. */
export function parseAmount(text) {
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) throw new Error(\`Bad amount: \${text}\`);
  return Math.floor(value * 100);
}
`,
    "src/cart.js": `import { parseAmount } from "./money.js";

/** Subtotal, tax and total in cents for cart lines of { price, qty }. */
export function cartTotal(lines, taxBasisPoints) {
  let subtotal = 0;
  for (let i = 1; i < lines.length; i++) subtotal += parseAmount(lines[i].price) * lines[i].qty;
  const tax = Math.round((subtotal * taxBasisPoints) / 10_000);
  return { subtotal, tax, total: subtotal + tax };
}
`,
    "src/index.js": `export { parseAmount } from "./money.js";\nexport { cartTotal } from "./cart.js";\n`,
    "test/money.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount } from "../src/index.js";

const cases = ${JSON.stringify(cases)};

test("parseAmount keeps every cent", () => {
  assert.equal(parseAmount("0.29"), 29);
  for (const [text, cents] of cases) assert.equal(parseAmount(text), cents, text);
});

test("parseAmount rejects garbage", () => {
  assert.throws(() => parseAmount("twelve"));
});
`,
    "test/cart.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal } from "../src/index.js";

test("cartTotal sums every line", () => {
  const cart = ${JSON.stringify(fixture.testCart)};
  assert.deepEqual(cartTotal(cart.lines, cart.taxBasisPoints), ${JSON.stringify(cartTotal(fixture.testCart))});
});

test("cartTotal of an empty cart is zero", () => {
  assert.deepEqual(cartTotal([], 800), { subtotal: 0, tax: 0, total: 0 });
});

test("cartTotal taxes a single line", () => {
  assert.deepEqual(cartTotal([{ price: "10.00", qty: 3 }], 825), { subtotal: 3000, tax: 248, total: 3248 });
});
`,
    "fixtures/carts.json": `${JSON.stringify(fixture.carts)}\n`,
    "verify.mjs": `import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cartTotal } from "./src/index.js";

const seed = Number(process.argv[2]) >>> 0;
const carts = JSON.parse(readFileSync(new URL("./fixtures/carts.json", import.meta.url), "utf8"));
const results = carts.map((cart) => cartTotal(cart.lines, cart.taxBasisPoints));
const digest = createHash("sha256").update(\`\${seed}\\n\${JSON.stringify(results)}\`).digest("hex");
console.log(JSON.stringify({ seed, carts: results.length, digest }));
`,
  };
}

/** The two surgical fixes an agent applies. */
export const nodeFixes: readonly ProjectEdit[] = [
  {
    path: "src/money.js",
    find: "return Math.floor(value * 100);",
    replace: "return Math.round(value * 100);",
  },
  {
    path: "src/cart.js",
    find: "for (let i = 1; i < lines.length; i++)",
    replace: "for (let i = 0; i < lines.length; i++)",
  },
];

/** The digest the fixed project's `verify.mjs` prints for `seed`. */
export const expectedNodeDigest = memo((seed: number) =>
  sha256Hex(`${seed >>> 0}\n${JSON.stringify(nodeFixture(seed).carts.map(cartTotal))}`),
);

const guestDigestReply = z.object({ seed: seedField, digest: hexDigest });

const nodeReport = z.strictObject({
  seed: seedField,
  failedBefore: z.boolean(),
  failingBefore: z.number().int(),
  passedTests: z.number().int(),
  failingAfter: z.number().int(),
  seconds: positiveSeconds,
  digest: hexDigest,
});

function verifyNodeFix(raw: string, seed: number): VerifyResult {
  const reply = decode(nodeReport, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (!data.failedBefore || data.failingBefore !== nodeFailingBefore)
    return {
      ok: false,
      reason: `want ${nodeFailingBefore} failing tests before the fix, got ${data.failingBefore}`,
    };

  if (data.passedTests !== nodeTestCount || data.failingAfter !== 0)
    return {
      ok: false,
      reason: `after the fix ${data.passedTests} passed and ${data.failingAfter} failed`,
    };

  if (data.digest !== expectedNodeDigest(seed))
    return { ok: false, reason: "digest does not match the seed" };

  return {
    ok: true,
    value: data.seconds,
    proof: data.digest,
    details: { failingBefore: data.failingBefore, passedTests: data.passedTests },
  };
}

const agentFixBugNode: ExpandedScenario = {
  id: "agent-fix-bug-node",
  category: "agent-tasks",
  label: "Fix a Node bug",
  description:
    "Writes a seeded Node ESM project, sees node --test fail, fixes two bugs with file edits, and reruns the tests.",
  unit: "s",
  better: "lower",
  async run(box, ctx) {
    const started = performance.now();
    await freshProject(box, nodeRoot, nodeProjectFiles(ctx.seed), ctx.timeoutMs);
    const before = await box.run(nodeTestCommand, { timeoutMs: ctx.timeoutMs });

    for (const fix of nodeFixes) await box.files.edit(`${nodeRoot}/${fix.path}`, fix);

    const after = await box.run(nodeTestCommand, { timeoutMs: ctx.timeoutMs });

    const guest = lastLine(
      guestDigestReply,
      await command(box, `cd ${nodeRoot} && node verify.mjs ${ctx.seed >>> 0}`, ctx.timeoutMs),
      "verify.mjs",
    );

    const seconds = secondsSince(started);
    await box.run(`rm -rf ${nodeRoot}`, { timeoutMs: ctx.timeoutMs });

    const raw = JSON.stringify({
      seed: guest.seed,
      failedBefore: !before.ok,
      failingBefore: tapCounts(before.stdout).fail,
      passedTests: tapCounts(after.stdout).pass,
      failingAfter: after.ok
        ? tapCounts(after.stdout).fail
        : Math.max(1, tapCounts(after.stdout).fail),
      seconds,
      digest: guest.digest,
    });

    return outcomeOf("agent-fix-bug-node", verifyNodeFix(raw, ctx.seed));
  },
  verifyOutput: verifyNodeFix,
};

// ---------------------------------------------------------------------------------------------
// agent-fix-bug-python
// ---------------------------------------------------------------------------------------------

const pyRoot = "/workspace/bench-agent-py";
const pyTestCommand = `cd ${pyRoot} && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -t .`;

/** Tests in the Python package, and how many the seeded bug breaks. */
export const pyTestCount = 4;
export const pyFailingBefore = 2;

const pySkuCount = 40;
const pyRowCount = 3000;

interface StockRow {
  readonly sku: string;
  readonly kind: "receive" | "ship";
  readonly qty: number;
}

/** A SKU with seeded case and padding, so the code under test must normalize it. */
function seededSku(next: () => number): string {
  const id = `sku-${String(next() % pySkuCount).padStart(3, "0")}`;
  const cased = next() % 2 === 0 ? id : id.toUpperCase();

  return next() % 5 === 0 ? ` ${cased} ` : cased;
}

function seededRow(next: () => number): StockRow {
  const sku = seededSku(next);
  const kind = next() % 3 === 0 ? "ship" : "receive";

  return { sku, kind, qty: 1 + (next() % 50) };
}

/** The fixed `summarize`: net quantity per normalized SKU, sorted by SKU. */
function summarizeStock(rows: readonly StockRow[]): readonly (readonly [string, number])[] {
  const totals = new Map<string, number>();

  for (const row of rows) {
    const sku = row.sku.trim().toUpperCase();
    totals.set(sku, (totals.get(sku) ?? 0) + (row.kind === "receive" ? row.qty : -row.qty));
  }

  return [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function csvOf(rows: readonly StockRow[]): string {
  return `sku,kind,qty\n${rows.map((r) => `${r.sku},${r.kind},${r.qty}`).join("\n")}\n`;
}

const pyFixture = memo((seed: number) => {
  const next = rng32(seed ^ 0x9e7);

  // Two receipts for a SKU the generator never makes: the overwrite bug reports 3, not 5, whatever the seed.
  const anchor: readonly StockRow[] = [
    { sku: "acc-x", kind: "receive", qty: 2 },
    { sku: "ACC-X", kind: "receive", qty: 3 },
  ];

  const testRows = [...anchor, ...Array.from({ length: 24 }, () => seededRow(next))];
  const rows = Array.from({ length: pyRowCount }, () => seededRow(next));

  return { testRows, rows };
});

/** The seeded Python package, with one bug: the ledger overwrites each SKU's total instead of adding to it. */
export function pyProjectFiles(seed: number) {
  const fixture = pyFixture(seed);
  const expected = Object.fromEntries(summarizeStock(fixture.testRows));

  return {
    "inventory/__init__.py": `from .ledger import summarize\nfrom .parse import parse_rows\n\n__all__ = ["parse_rows", "summarize"]\n`,
    "inventory/parse.py": `import csv
import io


def parse_rows(text):
    """Parse sku,kind,qty CSV text into row dicts with integer quantities."""
    return [
        {"sku": row["sku"], "kind": row["kind"], "qty": int(row["qty"])}
        for row in csv.DictReader(io.StringIO(text))
    ]
`,
    "inventory/ledger.py": `def summarize(records):
    """Net stock per SKU: receipts add, shipments subtract. SKUs are trimmed and upper-cased."""
    totals = {}
    for record in records:
        sku = record["sku"].strip().upper()
        qty = record["qty"] if record["kind"] == "receive" else -record["qty"]
        totals[sku] = qty
    return dict(sorted(totals.items()))
`,
    "tests/__init__.py": "",
    "tests/test_ledger.py": `import json
import unittest

from inventory import parse_rows, summarize

ROWS = json.loads(${JSON.stringify(JSON.stringify(fixture.testRows))})
EXPECTED = json.loads(${JSON.stringify(JSON.stringify(expected))})


class LedgerTest(unittest.TestCase):
    def test_accumulates_seeded_rows(self):
        self.assertEqual(summarize(ROWS), EXPECTED)

    def test_shipments_subtract(self):
        rows = [
            {"sku": "a-1", "kind": "receive", "qty": 10},
            {"sku": "A-1 ", "kind": "ship", "qty": 3},
        ]
        self.assertEqual(summarize(rows), {"A-1": 7})

    def test_parse_rows(self):
        self.assertEqual(parse_rows("sku,kind,qty\\nx,ship,4\\n"), [{"sku": "x", "kind": "ship", "qty": 4}])

    def test_empty(self):
        self.assertEqual(summarize([]), {})


if __name__ == "__main__":
    unittest.main()
`,
    "data.csv": csvOf(fixture.rows),
    "verify.py": `import hashlib
import json
import sys
from pathlib import Path

from inventory import parse_rows, summarize

seed = int(sys.argv[1])
rows = parse_rows(Path(__file__).with_name("data.csv").read_text())
summary = summarize(rows)
body = ";".join(f"{sku}={qty}" for sku, qty in summary.items())
digest = hashlib.sha256(f"{seed}\\n{body}".encode()).hexdigest()
print(json.dumps({"seed": seed, "rows": len(rows), "skus": len(summary), "digest": digest}))
`,
  };
}

/** The one-line fix an agent applies. */
export const pyFix: ProjectEdit = {
  path: "inventory/ledger.py",
  find: "        totals[sku] = qty\n",
  replace: "        totals[sku] = totals.get(sku, 0) + qty\n",
};

/** The digest the fixed package's `verify.py` prints for `seed`. */
export const expectedPyDigest = memo((seed: number) => {
  const body = summarizeStock(pyFixture(seed).rows)
    .map(([sku, qty]) => `${sku}=${qty}`)
    .join(";");

  return sha256Hex(`${seed >>> 0}\n${body}`);
});

/** Counts from `python3 -m unittest` output: tests run, and failures plus errors. */
export interface UnittestCounts {
  readonly ran: number;
  readonly failed: number;
}

export function unittestCounts(output: string): UnittestCounts {
  const ran = Number(/^Ran (\d+) tests? in /m.exec(output)?.[1] ?? -1);

  if (/^OK$/m.test(output)) return { ran, failed: 0 };

  const summary = /^FAILED \(([^)]*)\)$/m.exec(output)?.[1] ?? "";
  let failed = 0;

  for (const match of summary.matchAll(/(?:failures|errors)=(\d+)/g)) failed += Number(match[1]);

  return { ran, failed: failed === 0 ? -1 : failed };
}

const pyReport = z.strictObject({
  seed: seedField,
  failedBefore: z.boolean(),
  failingBefore: z.number().int(),
  passedTests: z.number().int(),
  failingAfter: z.number().int(),
  seconds: positiveSeconds,
  digest: hexDigest,
});

function verifyPyFix(raw: string, seed: number): VerifyResult {
  const reply = decode(pyReport, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (!data.failedBefore || data.failingBefore !== pyFailingBefore)
    return {
      ok: false,
      reason: `want ${pyFailingBefore} failing tests before the fix, got ${data.failingBefore}`,
    };

  if (data.passedTests !== pyTestCount || data.failingAfter !== 0)
    return {
      ok: false,
      reason: `after the fix ${data.passedTests} passed and ${data.failingAfter} failed`,
    };

  if (data.digest !== expectedPyDigest(seed))
    return { ok: false, reason: "digest does not match the seed" };

  return {
    ok: true,
    value: data.seconds,
    proof: data.digest,
    details: { failingBefore: data.failingBefore, passedTests: data.passedTests },
  };
}

const agentFixBugPython: ExpandedScenario = {
  id: "agent-fix-bug-python",
  category: "agent-tasks",
  label: "Fix a Python bug",
  description:
    "Writes a seeded Python package, sees unittest fail, fixes the ledger bug with a file edit, and reruns the tests.",
  unit: "s",
  better: "lower",
  async run(box, ctx) {
    const started = performance.now();
    await freshProject(box, pyRoot, pyProjectFiles(ctx.seed), ctx.timeoutMs);
    const before = await box.run(pyTestCommand, { timeoutMs: ctx.timeoutMs });
    await box.files.edit(`${pyRoot}/${pyFix.path}`, pyFix);
    const after = await box.run(pyTestCommand, { timeoutMs: ctx.timeoutMs });

    const guest = lastLine(
      guestDigestReply,
      await command(
        box,
        `cd ${pyRoot} && PYTHONDONTWRITEBYTECODE=1 python3 verify.py ${ctx.seed >>> 0}`,
        ctx.timeoutMs,
      ),
      "verify.py",
    );

    const seconds = secondsSince(started);
    await box.run(`rm -rf ${pyRoot}`, { timeoutMs: ctx.timeoutMs });
    const beforeCounts = unittestCounts(before.output);
    const afterCounts = unittestCounts(after.output);

    const raw = JSON.stringify({
      seed: guest.seed,
      failedBefore: !before.ok,
      failingBefore: beforeCounts.failed,
      passedTests: after.ok ? afterCounts.ran - afterCounts.failed : 0,
      failingAfter: after.ok ? afterCounts.failed : Math.max(1, afterCounts.failed),
      seconds,
      digest: guest.digest,
    });

    return outcomeOf("agent-fix-bug-python", verifyPyFix(raw, ctx.seed));
  },
  verifyOutput: verifyPyFix,
};

// ---------------------------------------------------------------------------------------------
// agent-refactor-codemod
// ---------------------------------------------------------------------------------------------

const codemodRoot = "/workspace/bench-codemod";

/** Modules in the generated repo, plus the core module they import from. */
export const codemodModuleCount = 40;
const legacyName = "legacyScore";

/** Files the codemod must change (40 modules and the core) and identifiers it must rename. */
export const codemodFilesChanged = codemodModuleCount + 1;
export const codemodReplacements = codemodModuleCount * 4 + 1;

/** The seed-specific name the codemod renames `legacyScore` to. */
export function codemodTargetName(seed: number): string {
  return `score_${(seed >>> 0).toString(16)}`;
}

function moduleName(index: number): string {
  return `m${String(index).padStart(2, "0")}.mjs`;
}

const codemodFixture = memo((seed: number) => {
  const next = rng32(seed ^ 0xc0de);
  const version = 1 + (next() % 9);
  const start = next();
  const constants = Array.from({ length: codemodModuleCount }, () => [next(), next()] as const);

  return { version, start, constants };
});

/** The seeded repo: a core module exporting `legacyScore`, and 40 chained modules that import and call it. */
export function codemodProjectFiles(seed: number) {
  const { version, start, constants } = codemodFixture(seed);

  const modules = Object.fromEntries(
    constants.map(([first, second], index) => {
      const upstream =
        index === 0
          ? `const upstream = ${start};`
          : `import { value as upstream } from "./${moduleName(index - 1)}";`;

      return [
        `src/${moduleName(index)}`,
        `import { ${legacyName}, ${legacyName}Version } from "./core.mjs";
${upstream}

export const value = ${legacyName}(${legacyName}(upstream, ${first}), ${second} + ${legacyName}Version);
export const via = ${legacyName}.name;
`,
      ];
    }),
  );

  return {
    "package.json": `${JSON.stringify({ name: "bench-codemod", private: true, type: "module" }, null, 2)}\n`,
    "src/core.mjs": `export const ${legacyName}Version = ${version};

/** Mix two 32-bit values into one score. */
export function ${legacyName}(a, b) {
  return (Math.imul(a, 31) ^ b) >>> 0;
}
`,
    ...modules,
    "codemod.mjs": `import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, from, to] = process.argv.slice(2);
const pattern = new RegExp(\`\\\\b\${from}\\\\b\`, "g");
let files = 0;
let replacements = 0;
for (const name of readdirSync(root).sort()) {
  if (!name.endsWith(".mjs")) continue;
  const path = join(root, name);
  const text = readFileSync(path, "utf8");
  const count = (text.match(pattern) ?? []).length;
  if (count === 0) continue;
  writeFileSync(path, text.replace(pattern, to));
  files += 1;
  replacements += count;
}
console.log(JSON.stringify({ files, replacements }));
`,
    "verify.mjs": `import { createHash } from "node:crypto";

const seed = Number(process.argv[2]) >>> 0;
const lines = [];
for (let i = 0; i < ${codemodModuleCount}; i++) {
  const mod = await import(\`./src/m\${String(i).padStart(2, "0")}.mjs\`);
  lines.push(\`\${i}:\${mod.value}:\${mod.via}\`);
}
const renamed = lines[0].split(":")[2];
const digest = createHash("sha256").update(\`\${seed}\\n\${lines.join("\\n")}\`).digest("hex");
console.log(JSON.stringify({ seed, modules: lines.length, renamed, digest }));
`,
  };
}

/** The digest `verify.mjs` prints once every module calls the renamed function. */
export const expectedCodemodDigest = memo((seed: number) => {
  const { version, start, constants } = codemodFixture(seed);
  const name = codemodTargetName(seed);
  const score = (a: number, b: number) => (Math.imul(a, 31) ^ b) >>> 0;
  const lines: string[] = [];
  let upstream = start;

  constants.forEach(([first, second], index) => {
    upstream = score(score(upstream, first), second + version);
    lines.push(`${index}:${upstream}:${name}`);
  });

  return sha256Hex(`${seed >>> 0}\n${lines.join("\n")}`);
});

const codemodRun = z.object({ files: z.number().int(), replacements: z.number().int() });

const codemodVerify = z.object({
  seed: seedField,
  modules: z.number().int(),
  renamed: z.string(),
  digest: hexDigest,
});

const codemodReport = z.strictObject({
  seed: seedField,
  modules: z.number().int(),
  renamed: z.string(),
  filesChanged: z.number().int(),
  replacements: z.number().int(),
  staleReferences: z.boolean(),
  seconds: positiveSeconds,
  digest: hexDigest,
});

function verifyCodemod(raw: string, seed: number): VerifyResult {
  const reply = decode(codemodReport, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.modules !== codemodModuleCount)
    return { ok: false, reason: `imported ${data.modules} modules, want ${codemodModuleCount}` };

  if (data.renamed !== codemodTargetName(seed))
    return {
      ok: false,
      reason: `symbol renamed to ${data.renamed}, want ${codemodTargetName(seed)}`,
    };

  if (data.filesChanged !== codemodFilesChanged || data.replacements !== codemodReplacements)
    return {
      ok: false,
      reason: `codemod changed ${data.filesChanged} files and ${data.replacements} references`,
    };

  if (data.staleReferences)
    return { ok: false, reason: `${legacyName} is still referenced after the codemod` };

  if (data.digest !== expectedCodemodDigest(seed))
    return { ok: false, reason: "digest does not match the seed" };

  return {
    ok: true,
    value: data.seconds,
    proof: data.digest,
    details: { modules: data.modules, replacements: data.replacements },
  };
}

const agentRefactorCodemod: ExpandedScenario = {
  id: "agent-refactor-codemod",
  category: "agent-tasks",
  label: "Codemod rename",
  description:
    "Renames an exported function across 40 chained ES modules with a codemod, then imports every module to check the result.",
  unit: "s",
  better: "lower",
  async run(box, ctx) {
    const started = performance.now();
    const target = codemodTargetName(ctx.seed);
    await writeTree(box, codemodRoot, codemodProjectFiles(ctx.seed), ctx.timeoutMs);

    const codemod = lastLine(
      codemodRun,
      await command(
        box,
        `cd ${codemodRoot} && node codemod.mjs src ${legacyName} ${target}`,
        ctx.timeoutMs,
      ),
      "codemod.mjs",
    );

    const stale = await box.run(`grep -rlw ${legacyName} ${codemodRoot}/src`, {
      timeoutMs: ctx.timeoutMs,
    });

    const guest = lastLine(
      codemodVerify,
      await command(box, `cd ${codemodRoot} && node verify.mjs ${ctx.seed >>> 0}`, ctx.timeoutMs),
      "verify.mjs",
    );

    const seconds = secondsSince(started);
    await box.run(`rm -rf ${codemodRoot}`, { timeoutMs: ctx.timeoutMs });

    const raw = JSON.stringify({
      seed: guest.seed,
      modules: guest.modules,
      renamed: guest.renamed,
      filesChanged: codemod.files,
      replacements: codemod.replacements,
      // grep exits 1 when nothing matches; 0 means a file still names the old symbol.
      staleReferences: stale.exitCode !== 1,
      seconds,
      digest: guest.digest,
    });

    return outcomeOf("agent-refactor-codemod", verifyCodemod(raw, ctx.seed));
  },
  verifyOutput: verifyCodemod,
};

// ---------------------------------------------------------------------------------------------
// agent-debug-log-triage
// ---------------------------------------------------------------------------------------------

const logRoot = "/workspace/bench-logs";

/** Lines in the generated service log. */
export const logLineCount = 30_000;
const logSpikeLines = 6000;

const logServices = [
  "api-gateway",
  "auth",
  "billing",
  "catalog",
  "checkout",
  "inventory",
  "notifications",
  "search",
] as const;

const logRoutes = [
  "GET /v1/items",
  "POST /v1/orders",
  "GET /v1/users/:id",
  "PUT /v1/cart",
  "POST /v1/login",
  "GET /healthz",
] as const;

interface LogEntry {
  readonly ts: string;
  readonly level: "error" | "warn" | "info";
  readonly service: string;
  readonly route: string;
  readonly status: number;
  readonly latencyMs: number;
  readonly traceId: string;
}

/** The generator `gen.mjs` runs in the guest. Kept in step with `logEntries` below. */
export const logGeneratorScript = `import { writeFileSync } from "node:fs";
${rngSource}
const seed = Number(process.argv[2]) >>> 0;
const path = process.argv[3];
const services = ${JSON.stringify(logServices)};
const routes = ${JSON.stringify(logRoutes)};
const next = rng32(seed ^ 0x10c5);
const culprit = services[next() % services.length];
const spikeStart = 5000 + (next() % 15000);
const base = 1767225600000 + (next() % 86400) * 1000;
const lines = [];
for (let i = 0; i < ${logLineCount}; i++) {
  const a = next(), b = next(), c = next(), d = next();
  const service = services[a % services.length];
  const inSpike = service === culprit && i >= spikeStart && i < spikeStart + ${logSpikeLines};
  const roll = b % 1000;
  const status = (inSpike && roll < 450) || roll < 8 ? 500 + (roll % 4) : roll < 40 ? 400 + (roll % 5) : 200;
  const latencyMs = 15 + (c % 220) + (inSpike ? 300 + (d % 900) : 0);
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  lines.push(JSON.stringify({
    ts: new Date(base + i * 41).toISOString(),
    level,
    service,
    route: routes[d % routes.length],
    status,
    latencyMs,
    traceId: ((a ^ c) >>> 0).toString(16).padStart(8, "0"),
  }));
}
writeFileSync(path, lines.join("\\n") + "\\n");
console.log(JSON.stringify({ seed, lines: lines.length }));
`;

/** The triage script `analyze.mjs`: top failing service, its error count and p95 error latency. */
export const logAnalyzerScript = `import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const seed = Number(process.argv[2]) >>> 0;
const bytes = readFileSync(process.argv[3]);
const errors = new Map();
const latencies = new Map();
let totalLines = 0;
for (const line of bytes.toString("utf8").split("\\n")) {
  if (line === "") continue;
  totalLines += 1;
  const entry = JSON.parse(line);
  if (entry.status < 500) continue;
  errors.set(entry.service, (errors.get(entry.service) ?? 0) + 1);
  const list = latencies.get(entry.service) ?? [];
  list.push(entry.latencyMs);
  latencies.set(entry.service, list);
}
const [culpritService, errorCount] = [...errors.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
const sorted = latencies.get(culpritService).sort((x, y) => x - y);
const p95LatencyMs = sorted[Math.ceil(sorted.length * 0.95) - 1];
const fileDigest = createHash("sha256").update(bytes).digest("hex");
const digest = createHash("sha256")
  .update(\`\${seed}|\${totalLines}|\${culpritService}|\${errorCount}|\${p95LatencyMs}|\${fileDigest}\`)
  .digest("hex");
console.log(JSON.stringify({ seed, totalLines, culpritService, errorCount, p95LatencyMs, digest }));
`;

interface LogFixture {
  readonly culprit: string;
  readonly entries: readonly LogEntry[];
}

function logEntries(seed: number): LogFixture {
  const next = rng32(seed ^ 0x10c5);
  const culprit = logServices[next() % logServices.length] ?? "auth";
  const spikeStart = 5000 + (next() % 15000);
  const base = 1_767_225_600_000 + (next() % 86_400) * 1000;
  const entries: LogEntry[] = [];

  for (let i = 0; i < logLineCount; i++) {
    const a = next();
    const b = next();
    const c = next();
    const d = next();
    const service = logServices[a % logServices.length] ?? "auth";
    const inSpike = service === culprit && i >= spikeStart && i < spikeStart + logSpikeLines;
    const roll = b % 1000;

    const status =
      (inSpike && roll < 450) || roll < 8 ? 500 + (roll % 4) : roll < 40 ? 400 + (roll % 5) : 200;

    entries.push({
      ts: new Date(base + i * 41).toISOString(),
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      service,
      route: logRoutes[d % logRoutes.length] ?? "GET /healthz",
      status,
      latencyMs: 15 + (c % 220) + (inSpike ? 300 + (d % 900) : 0),
      traceId: ((a ^ c) >>> 0).toString(16).padStart(8, "0"),
    });
  }

  return { culprit, entries };
}

/** What a correct triage of the seeded log finds. */
export const expectedLogTriage = memo((seed: number) => {
  const { culprit, entries } = logEntries(seed);
  const text = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const errors = new Map<string, number[]>();

  for (const entry of entries) {
    if (entry.status < 500) continue;

    const list = errors.get(entry.service) ?? [];
    list.push(entry.latencyMs);
    errors.set(entry.service, list);
  }

  const [culpritService = "", latencies = []] =
    [...errors.entries()].sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1))[0] ??
    [];

  const sorted = [...latencies].sort((x, y) => x - y);
  const p95LatencyMs = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
  const fileDigest = createHash("sha256").update(text).digest("hex");

  const digest = sha256Hex(
    `${seed >>> 0}|${entries.length}|${culpritService}|${latencies.length}|${p95LatencyMs}|${fileDigest}`,
  );

  return { injected: culprit, culpritService, errorCount: latencies.length, p95LatencyMs, digest };
});

const logReport = z.strictObject({
  seed: seedField,
  totalLines: z.number().int(),
  culpritService: z.string(),
  errorCount: z.number().int(),
  p95LatencyMs: z.number().int(),
  seconds: positiveSeconds,
  digest: hexDigest,
});

const logAnalysis = logReport.omit({ seconds: true });

function verifyLogTriage(raw: string, seed: number): VerifyResult {
  const reply = decode(logReport, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  const expected = expectedLogTriage(seed);

  if (data.totalLines !== logLineCount)
    return { ok: false, reason: `read ${data.totalLines} lines, want ${logLineCount}` };

  if (data.culpritService !== expected.culpritService)
    return { ok: false, reason: `blamed ${data.culpritService}, want ${expected.culpritService}` };

  if (data.errorCount !== expected.errorCount || data.p95LatencyMs !== expected.p95LatencyMs)
    return { ok: false, reason: `found ${data.errorCount} errors at p95 ${data.p95LatencyMs} ms` };

  if (data.digest !== expected.digest)
    return { ok: false, reason: "digest does not match the seed" };

  return {
    ok: true,
    value: data.seconds,
    proof: data.digest,
    details: {
      culpritService: data.culpritService,
      errorCount: data.errorCount,
      p95LatencyMs: data.p95LatencyMs,
    },
  };
}

const agentDebugLogTriage: ExpandedScenario = {
  id: "agent-debug-log-triage",
  category: "agent-tasks",
  label: "Log triage",
  description:
    "Generates 30,000 seeded JSONL service log lines with an error spike, inspects them, and finds the failing service and its p95 latency.",
  unit: "s",
  better: "lower",
  async run(box, ctx) {
    const started = performance.now();
    await freshProject(
      box,
      logRoot,
      { "gen.mjs": logGeneratorScript, "analyze.mjs": logAnalyzerScript },
      ctx.timeoutMs,
    );
    await command(box, `cd ${logRoot} && node gen.mjs ${ctx.seed >>> 0} app.jsonl`, ctx.timeoutMs);
    const lineCount = Number(await command(box, `wc -l < ${logRoot}/app.jsonl`, ctx.timeoutMs));

    if (lineCount !== logLineCount)
      throw new Error(`app.jsonl has ${lineCount} lines, want ${logLineCount}`);

    await command(
      box,
      `head -n 3 ${logRoot}/app.jsonl && grep -c '"level":"error"' ${logRoot}/app.jsonl`,
      ctx.timeoutMs,
    );

    const analysis = lastLine(
      logAnalysis,
      await command(
        box,
        `cd ${logRoot} && node analyze.mjs ${ctx.seed >>> 0} app.jsonl`,
        ctx.timeoutMs,
      ),
      "analyze.mjs",
    );

    const seconds = secondsSince(started);
    await box.run(`rm -rf ${logRoot}`, { timeoutMs: ctx.timeoutMs });

    return outcomeOf(
      "agent-debug-log-triage",
      verifyLogTriage(JSON.stringify({ ...analysis, seconds }), ctx.seed),
    );
  },
  verifyOutput: verifyLogTriage,
};

export const agentTaskScenarios: readonly ExpandedScenario[] = [
  agentFixBugNode,
  agentFixBugPython,
  agentRefactorCodemod,
  agentDebugLogTriage,
];

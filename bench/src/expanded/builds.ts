/**
 * Build scenarios: a TypeScript project stripped and bundled by Node itself, a Python package
 * compiled to bytecode, a local git branch-and-merge workflow, and an HTTP server under load.
 * Every program needs only what node:22-bookworm ships; none touches the network.
 *
 * One build takes 0.05 to 0.15 s, so each scenario repeats it from scratch in timed rounds (see
 * `rounds.ts`) for at least a second. Build times report the median round; the HTTP server
 * reports requests per second over every round.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  digestSchema,
  failure,
  hexInt,
  manifestDigest,
  nodePrelude,
  outcomeOf,
  parseGuestJson,
  proofOf,
  pythonPrelude,
  runGuestProgram,
  seededHex,
  seedMismatch,
  seedSchema,
  sha256Hex,
} from "./guest-kit.js";
import {
  checkRounds,
  nodeRoundsSource,
  perRound,
  proofIs,
  pythonRoundsSource,
  roundsSchema,
} from "./rounds.js";
import type { ExpandedScenario, VerifyResult } from "./types.js";

/** Minimum timed rounds for every build scenario. */
const buildMinRounds = 5;

const modulus = 1_000_003;

/** `acc` folds f(x) over x in [0, inputs) and `samples` holds f(0..4), as both entry points print. */
function foldResult(f: (x: number) => number, inputs: number): string {
  let acc = 0;
  const samples: number[] = [];

  for (let x = 0; x < inputs; x++) {
    const value = f(x);
    acc = (acc * 31 + value) % modulus;

    if (x < 5) samples.push(value);
  }

  return JSON.stringify({ acc, samples });
}

// build-ts-strip-bundle

const tsModules = 30;
const tsInputs = 2000;

/** Module `i`'s constants in round `round`, from the seeded generator. */
function tsConstants(seed: number, round: number, i: number) {
  const hex = seededHex(seed, "ts", round, i);

  return {
    scale: 1 + (hexInt(hex, 0, 4) % 997),
    shift: hexInt(hex, 4, 8) % 10_007,
    constant: hexInt(hex, 8, 12) % 101,
    mul: hexInt(hex, 12, 13) % 2 === 1,
  };
}

/** What `node dist/bundle.mjs` prints in round `round`: every round generates its own modules. */
export function expectedTsOutput(seed: number, round = 0): string {
  const constants = Array.from({ length: tsModules }, (_, i) => tsConstants(seed, round, i));

  const f = (x: number) => {
    let previous = 0;

    for (let i = 0; i < tsModules; i++) {
      const c = constants[i];

      if (!c) break;
      const base = c.mul ? x * c.scale : x + c.scale;
      const shared = i > 1 ? (constants[Math.floor(i / 2)]?.constant ?? 0) : 0;
      previous = (base + c.shift + (i > 0 ? previous : 0) + shared) % modulus;
    }

    return previous;
  };

  return foldResult(f, tsInputs);
}

export const expectedTsDigest = perRound((seed, round) => sha256Hex(expectedTsOutput(seed, round)));

export const tsBundleProgram = `${nodePrelude}
${nodeRoundsSource}
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
const N = ${tsModules};
const pad = (i) => String(i).padStart(2, "0");
mkdirSync(ROOT + "/src", { recursive: true });
writeFileSync(ROOT + "/src/run.ts", 'import { main } from "./m' + pad(N - 1) + '.ts";\\nconsole.log(main());\\n');
// Untimed: the round's own project, every module's constants drawn for this round.
const prepare = (round) => {
for (let i = 0; i < N; i++) {
  const hex = h("ts", round, i);
  const scale = 1 + (parseInt(hex.slice(0, 4), 16) % 997);
  const shift = parseInt(hex.slice(4, 8), 16) % 10007;
  const constant = parseInt(hex.slice(8, 12), 16) % 101;
  const mode = parseInt(hex.slice(12, 13), 16) % 2 === 1 ? "mul" : "add";
  const j = Math.floor(i / 2);
  const lines = [];
  if (i > 0) lines.push('import { f' + (i - 1) + ' } from "./m' + pad(i - 1) + '.ts";');
  if (i > 1) lines.push('import { C' + j + ' } from "./m' + pad(j) + '.ts";');
  lines.push(
    "export enum Kind" + i + " { Scale = " + scale + ", Shift = " + shift + " }",
    "export interface Box" + i + "<T> { readonly value: T; readonly kind: Kind" + i + " }",
    "export type Mode" + i + ' = "add" | "mul";',
    "export const C" + i + ": number = " + constant + ";",
    "function wrap" + i + "<T>(value: T, kind: Kind" + i + "): Box" + i + "<T> { return { value, kind }; }",
    "const mode" + i + ": Mode" + i + ' = "' + mode + '" as Mode' + i + ";",
    "export function f" + i + "(x: number): number {",
    "  const box: Box" + i + "<number> = wrap" + i + "<number>(x, Kind" + i + ".Scale);",
    "  const base: number = mode" + i + ' === "mul" ? box.value * box.kind : box.value + box.kind;',
    "  return (base + Kind" + i + ".Shift" + (i > 0 ? " + f" + (i - 1) + "(x)" : "") + (i > 1 ? " + C" + j : "") + ") % ${modulus};",
    "}",
  );
  if (i === N - 1)
    lines.push(
      "export function main(): string {",
      "  let acc = 0;",
      "  const samples: number[] = [];",
      "  for (let x = 0; x < ${tsInputs}; x++) {",
      "    const value: number = f" + i + "(x);",
      "    acc = (acc * 31 + value) % ${modulus};",
      "    if (x < 5) samples.push(value);",
      "  }",
      "  return JSON.stringify({ acc, samples });",
      "}",
    );
  writeFileSync(ROOT + "/src/m" + pad(i) + ".ts", lines.join("\\n") + "\\n");
}
return ROOT + "/src";
};
let bundled = "";
const rounds = await timedRounds(${buildMinRounds}, prepare, (src) => {
  rmSync(ROOT + "/dist", { recursive: true, force: true });
  mkdirSync(ROOT + "/dist");
  const parts = ["// bundled by bench-ts-build"];
  for (let i = 0; i < N; i++) {
    let js = stripTypeScriptTypes(readFileSync(src + "/m" + pad(i) + ".ts", "utf8"), { mode: "transform" });
    js = js.replace(/^import \\{ (\\w+) \\} from "\\.\\/m(\\d+)\\.ts";$/gm, (_, name, n) => "const { " + name + " } = __m" + Number(n) + ";");
    js = js.replace(/^export (function|const|var|let) /gm, "$1 ");
    if (/^\\s*(import|export)\\b/m.test(js)) throw new Error("unbundled module syntax in m" + pad(i));
    const names = ["f" + i, "C" + i, "Kind" + i].concat(i === N - 1 ? ["main"] : []);
    parts.push("const __m" + i + " = (() => {\\n" + js + "\\nreturn { " + names.join(", ") + " };\\n})();");
  }
  parts.push("console.log(__m" + (N - 1) + ".main());");
  writeFileSync(ROOT + "/dist/bundle.mjs", parts.join("\\n") + "\\n");
  bundled = execFileSync(process.execPath, [ROOT + "/dist/bundle.mjs"], { encoding: "utf8" }).trim();
  return { proof: sha(bundled) };
});
// The last round's sources are still on disk: running them directly must print what its bundle did.
const direct = execFileSync(process.execPath, ["--no-warnings", "--experimental-transform-types", ROOT + "/src/run.ts"], { encoding: "utf8" }).trim();
if (direct !== bundled) throw new Error("bundle output differs from direct TypeScript execution");
console.log(JSON.stringify({ seed: SEED, moduleCount: N, bundleBytes: statSync(ROOT + "/dist/bundle.mjs").size, rounds, digest: rounds[0].proof }));
`;

const tsOutput = z.strictObject({
  seed: seedSchema,
  moduleCount: z.number().int(),
  bundleBytes: z.number().int(),
  rounds: roundsSchema,
  digest: digestSchema,
});

export function verifyTsBundle(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, tsOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.moduleCount !== tsModules)
    return failure(`moduleCount ${out.moduleCount}, expected ${tsModules}`);

  if (out.bundleBytes <= 0) return failure("bundle is empty");

  if (out.digest !== expectedTsDigest(seed, 0)) return failure("bundle output digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: buildMinRounds,
    check: proofIs((round) => expectedTsDigest(seed, round)),
  });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: rounds.medianSeconds,
    proof: proofOf("build-ts", out.digest),
    details: {
      moduleCount: out.moduleCount,
      bundleBytes: out.bundleBytes,
      rounds: rounds.count,
      seconds: rounds.totalSeconds,
    },
  };
}

// build-python-bytecode

const pyModules = 60;
const pyInputs = 2000;

function pyConstants(seed: number, round: number, i: number) {
  const hex = seededHex(seed, "py", round, i);
  const weights = [0, 1, 2].map((k) => hexInt(hex, 8 + 4 * k, 12 + 4 * k) % 101);

  return {
    scale: 1 + (hexInt(hex, 0, 4) % 997),
    shift: hexInt(hex, 4, 8) % 10_007,
    weighted: weights.reduce((sum, w, k) => sum + w * (k + 1), 0),
  };
}

/** What the package entry point returns in round `round`: every round generates its own package. */
export function expectedPyOutput(seed: number, round = 0): string {
  const constants = Array.from({ length: pyModules }, (_, i) => pyConstants(seed, round, i));

  const f = (x: number) => {
    let previous = 0;

    for (const c of constants) previous = (x * c.scale + c.shift + c.weighted + previous) % modulus;

    return previous;
  };

  return foldResult(f, pyInputs);
}

export const expectedPyDigest = perRound((seed, round) => sha256Hex(expectedPyOutput(seed, round)));

export const pyBytecodeProgram = `${pythonPrelude}
${pythonRoundsSource}
import glob, importlib, shutil, subprocess
N = ${pyModules}
pkg = os.path.join(ROOT, "benchpkg")
os.makedirs(pkg)
open(os.path.join(pkg, "__init__.py"), "w").write('"""Seeded benchmark package."""\\n')
def prepare(r):
    # Untimed: the round's own package, every module's constants drawn for this round.
    for i in range(N):
        hx = h("py", r, i)
        scale = 1 + int(hx[0:4], 16) % 997
        shift = int(hx[4:8], 16) % 10007
        weights = [int(hx[8 + 4 * k:12 + 4 * k], 16) % 101 for k in range(3)]
        lines = []
        if i > 0:
            lines.append("from benchpkg.m%02d import f%d" % (i - 1, i - 1))
        lines += [
            "P = ${modulus}",
            "W = %r" % (weights,),
            "class Table%d:" % i,
            "    def __init__(self, scale):",
            "        self.scale = scale",
            "    def apply(self, x):",
            "        return x * self.scale + %d" % shift,
            "T = Table%d(%d)" % (i, scale),
            "def f%d(x):" % i,
            "    parts = [w * (k + 1) for k, w in enumerate(W)]",
            "    return (T.apply(x) + sum(parts)%s) %% P" % (" + f%d(x)" % (i - 1) if i > 0 else ""),
        ]
        if i == N - 1:
            lines += [
                "def main():",
                "    acc, samples = 0, []",
                "    for x in range(${pyInputs}):",
                "        value = f%d(x)" % i,
                "        acc = (acc * 31 + value) % P",
                "        if x < 5:",
                "            samples.append(value)",
                "    return {'acc': acc, 'samples': samples}",
            ]
        open(os.path.join(pkg, "m%02d.py" % i), "w").write("\\n".join(lines) + "\\n")
    return pkg
sys.dont_write_bytecode = True
sys.path.insert(0, ROOT)
compiled = []
def work(package):
    # A clean build each round: no bytecode on disk and no package modules in this process.
    shutil.rmtree(os.path.join(package, "__pycache__"), ignore_errors=True)
    for name in [m for m in sys.modules if m == "benchpkg" or m.startswith("benchpkg.")]:
        del sys.modules[name]
    importlib.invalidate_caches()
    subprocess.run([sys.executable, "-m", "compileall", "-q", package], check=True)
    compiled.append(len(glob.glob(os.path.join(package, "__pycache__", "m[0-9][0-9].*.pyc"))))
    entry = importlib.import_module("benchpkg.m%02d" % (N - 1))
    if not entry.__cached__ or not os.path.exists(entry.__cached__):
        raise SystemExit("entry module has no bytecode")
    return {"proof": sha(json.dumps(entry.main(), separators=(",", ":")))}
rounds = timed_rounds(${buildMinRounds}, prepare, work)
print(json.dumps({"seed": SEED, "modulesCompiled": min(compiled), "rounds": rounds, "digest": rounds[0]["proof"]}))
`;

const pyOutput = z.strictObject({
  seed: seedSchema,
  modulesCompiled: z.number().int(),
  rounds: roundsSchema,
  digest: digestSchema,
});

export function verifyPyBytecode(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, pyOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.modulesCompiled !== pyModules)
    return failure(`modulesCompiled ${out.modulesCompiled}, expected ${pyModules}`);

  if (out.digest !== expectedPyDigest(seed, 0)) return failure("package result digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: buildMinRounds,
    check: proofIs((round) => expectedPyDigest(seed, round)),
  });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: rounds.medianSeconds,
    proof: proofOf("build-py", out.digest),
    details: {
      modulesCompiled: out.modulesCompiled,
      rounds: rounds.count,
      seconds: rounds.totalSeconds,
    },
  };
}

// build-git-workflow

/** 20 commits: 4 on main, 6 on feat-a, 2 on main, 6 on feat-b, 2 on main; then 2 merges. */
const gitPlan = [
  ...Array.from({ length: 4 }, () => "main"),
  ...Array.from({ length: 6 }, () => "feat-a"),
  ...Array.from({ length: 2 }, () => "main"),
  ...Array.from({ length: 6 }, () => "feat-b"),
  ...Array.from({ length: 2 }, () => "main"),
] as const;

const gitCommits = gitPlan.length + 2;
const gitTrackedFiles = 7;
const gitMergedFiles = 4;

const gitPath = (branch: string, n: number) =>
  branch === "main" ? `main/file${n % 3}.txt` : `${branch}/file${n % 2}.txt`;

const gitContent = (seed: number, round: number, n: number) =>
  [0, 1, 2, 3].map((k) => `${seededHex(seed, "git", round, n, k)}\n`).join("");

/**
 * Round `round`'s tree digest: SHA-256 of the commit count and the final working tree manifest,
 * where every round commits its own seeded contents.
 */
export const expectedGitDigest = perRound((seed, round) => {
  const tree = new Map<string, string>();

  gitPlan.forEach((branch, n) =>
    tree.set(gitPath(branch, n), sha256Hex(gitContent(seed, round, n))),
  );

  return sha256Hex(`${gitCommits}\n${manifestDigest(tree)}`);
});

export const gitProgram = `${nodePrelude}
${nodeRoundsSource}
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const repo = ROOT + "/repo";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });
const plan = ${JSON.stringify(gitPlan)};
const path = (branch, n) => branch === "main" ? "main/file" + (n % 3) + ".txt" : branch + "/file" + (n % 2) + ".txt";
let facts = null;
// Untimed: the round's own file contents, one array of lines per commit.
const prepare = (round) => plan.map((_, n) => [0, 1, 2, 3].map((k) => h("git", round, n, k) + "\\n").join(""));
const rounds = await timedRounds(${buildMinRounds}, prepare, (contents) => {
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo);
git("init", "-q", "-b", "main");
git("config", "user.name", "Bench");
git("config", "user.email", "bench@example.invalid");
git("config", "commit.gpgsign", "false");
let current = "main";
plan.forEach((branch, n) => {
  if (branch !== current) {
    if (branch === "main") git("checkout", "-q", "main");
    else git("checkout", "-q", "-b", branch);
    current = branch;
  }
  const rel = path(branch, n);
  mkdirSync(repo + "/" + rel.split("/")[0], { recursive: true });
  writeFileSync(repo + "/" + rel, contents[n]);
  git("add", rel);
  git("commit", "-q", "-m", "commit " + n + " on " + branch);
});
if (current !== "main") git("checkout", "-q", "main");
git("merge", "-q", "--no-ff", "-m", "merge feat-a", "feat-a");
git("merge", "-q", "--no-ff", "-m", "merge feat-b", "feat-b");
const commitCount = Number(git("rev-list", "--count", "HEAD").trim());
const logLines = git("log", "--oneline").trim().split("\\n").length;
const diffFiles = git("diff", "--name-only", "HEAD~2", "HEAD").trim().split("\\n").filter(Boolean).length;
const clean = git("status", "--porcelain").trim() === "";
const tracked = git("ls-files").trim().split("\\n");
const lines = tracked.sort().map((rel) => rel + ":" + sha(readFileSync(repo + "/" + rel)));
const onDisk = readdirSync(repo, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && !(e.parentPath ?? e.path).includes("/.git")).length;
if (onDisk !== tracked.length) throw new Error("untracked files in the working tree");
const roundFacts = { commitCount, logLines, diffFiles, trackedFiles: tracked.length, clean };
if (facts !== null && JSON.stringify(facts) !== JSON.stringify(roundFacts)) throw new Error("round facts differ: " + JSON.stringify(roundFacts));
facts = roundFacts;
return { proof: sha(commitCount + "\\n" + sha(lines.join("\\n"))) };
});
console.log(JSON.stringify({ seed: SEED, ...facts, rounds, digest: rounds[0].proof }));
`;

const gitOutput = z.strictObject({
  seed: seedSchema,
  commitCount: z.number().int(),
  logLines: z.number().int(),
  diffFiles: z.number().int(),
  trackedFiles: z.number().int(),
  clean: z.boolean(),
  rounds: roundsSchema,
  digest: digestSchema,
});

export function verifyGit(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, gitOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.commitCount !== gitCommits || out.logLines !== gitCommits)
    return failure(`commitCount ${out.commitCount}/${out.logLines}, expected ${gitCommits}`);

  if (out.diffFiles !== gitMergedFiles)
    return failure(`merge diff touched ${out.diffFiles} files, expected ${gitMergedFiles}`);

  if (out.trackedFiles !== gitTrackedFiles)
    return failure(`trackedFiles ${out.trackedFiles}, expected ${gitTrackedFiles}`);

  if (!out.clean) return failure("git status is not clean");

  if (out.digest !== expectedGitDigest(seed, 0)) return failure("tree digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: buildMinRounds,
    check: proofIs((round) => expectedGitDigest(seed, round)),
  });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: rounds.medianSeconds,
    proof: proofOf("build-git", out.digest),
    details: { commitCount: out.commitCount, rounds: rounds.count, seconds: rounds.totalSeconds },
  };
}

// build-http-server-load

const httpRequests = 200;
const httpClients = 50;

/**
 * The response digest round `round` must print: every round's server signs items with its own
 * key, `h("http-key", round)`.
 */
export const expectedHttpDigest = perRound((seed, round) => {
  const key = seededHex(seed, "http-key", round);

  return sha256Hex(
    Array.from(
      { length: httpRequests },
      (_, n) => `${n}:${createHmac("sha256", key).update(`item:${n}`).digest("hex")}`,
    ).join("\n"),
  );
});

export const httpProgram = `${nodePrelude}
${nodeRoundsSource}
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
let requests = ${httpRequests}, okCount = ${httpRequests}, connections = 0;
const rounds = await timedRounds(${buildMinRounds}, (round) => h("http-key", round), async (key) => {
const mac = (n) => createHmac("sha256", key).update("item:" + n).digest("hex");
const server = createServer((req, res) => {
  const match = /^\\/item\\/(\\d+)$/.exec(req.url ?? "");
  if (!match) { res.writeHead(404).end(); return; }
  const n = Number(match[1]);
  const body = JSON.stringify({ n, mac: createHmac("sha256", key).update("item:" + n).digest("hex") });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
});
server.keepAliveTimeout = 10000;
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const results = new Array(${httpRequests});
let next = 0;
const sockets = new Set();
server.on("connection", (socket) => sockets.add(socket));
await Promise.all(Array.from({ length: ${httpClients} }, async () => {
  while (next < ${httpRequests}) {
    const n = next++;
    const res = await fetch(base + "/item/" + n);
    const body = await res.json();
    results[n] = { n, status: res.status, ok: res.status === 200 && body.n === n && body.mac === mac(n), mac: body.mac };
  }
}));
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
requests = Math.min(requests, results.length);
okCount = Math.min(okCount, results.filter((r) => r && r.ok).length);
connections = Math.max(connections, sockets.size);
return { proof: sha(results.map((r) => r.n + ":" + r.mac).join("\\n")) };
});
console.log(JSON.stringify({ seed: SEED, requests, okCount, connections, rounds, digest: rounds[0].proof }));
`;

const httpOutput = z.strictObject({
  seed: seedSchema,
  requests: z.number().int(),
  okCount: z.number().int(),
  connections: z.number().int(),
  rounds: roundsSchema,
  digest: digestSchema,
});

export function verifyHttp(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, httpOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.requests !== httpRequests || out.okCount !== httpRequests)
    return failure(`okCount ${out.okCount}/${out.requests}, expected ${httpRequests}`);

  // Keep-alive: 50 clients share connections, so there are fewer connections than requests.
  if (out.connections < 1 || out.connections >= httpRequests)
    return failure(`connections ${out.connections}: requests did not reuse connections`);

  if (out.digest !== expectedHttpDigest(seed, 0)) return failure("response digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: buildMinRounds,
    check: proofIs((round) => expectedHttpDigest(seed, round)),
  });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: (httpRequests * rounds.count) / rounds.totalSeconds,
    proof: proofOf("build-http", out.digest),
    details: {
      seconds: rounds.totalSeconds,
      rounds: rounds.count,
      connections: out.connections,
    },
  };
}

export const buildScenarios: readonly ExpandedScenario[] = [
  {
    id: "build-ts-strip-bundle",
    category: "builds",
    label: "TypeScript strip and bundle",
    description:
      "Generate a 30-module TypeScript project (enums, generics, unions), then strip types with Node's built-in transformer, bundle it into one file and run it, in rounds for at least a second; reports the median round.",
    unit: "s",
    better: "lower",
    verifyOutput: verifyTsBundle,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        {
          dir: "/workspace/bench-ts-build",
          file: "build.mjs",
          source: tsBundleProgram,
          interpreter: "node",
        },
        ctx,
      );

      return outcomeOf("build-ts-strip-bundle", verifyTsBundle(raw, ctx.seed));
    },
  },
  {
    id: "build-python-bytecode",
    category: "builds",
    label: "Python bytecode build",
    description:
      "Generate a 60-module Python package, then compile it with python3 -m compileall and import and run its entry point from bytecode, in rounds for at least a second; reports the median round.",
    unit: "s",
    better: "lower",
    verifyOutput: verifyPyBytecode,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        {
          dir: "/workspace/bench-py-build",
          file: "build.py",
          source: pyBytecodeProgram,
          interpreter: "python3",
        },
        ctx,
      );

      return outcomeOf("build-python-bytecode", verifyPyBytecode(raw, ctx.seed));
    },
  },
  {
    id: "build-git-workflow",
    category: "builds",
    label: "git branch and merge",
    description:
      "Local git: init, 20 commits across main and two feature branches, two no-ff merges, log, diff and a clean status check, in rounds for at least a second; reports the median round.",
    unit: "s",
    better: "lower",
    verifyOutput: verifyGit,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        { dir: "/workspace/bench-git", file: "git.mjs", source: gitProgram, interpreter: "node" },
        ctx,
      );

      return outcomeOf("build-git-workflow", verifyGit(raw, ctx.seed));
    },
  },
  {
    id: "build-http-server-load",
    category: "builds",
    label: "Local HTTP server load",
    description:
      "Serve seeded HMAC JSON from a Node HTTP server on an ephemeral port and drive 200 keep-alive fetches from 50 concurrent clients, checking every response, in rounds for at least a second.",
    unit: "ops/s",
    better: "higher",
    verifyOutput: verifyHttp,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        {
          dir: "/workspace/bench-http",
          file: "http.mjs",
          source: httpProgram,
          interpreter: "node",
        },
        ctx,
      );

      return outcomeOf("build-http-server-load", verifyHttp(raw, ctx.seed));
    },
  },
];

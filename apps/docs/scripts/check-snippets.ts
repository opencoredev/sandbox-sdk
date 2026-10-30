/**
 * Type-checks every ```ts and ```tsx fence in content/ against the SDK's types.
 *
 *   bun scripts/check-snippets.ts   check against packages/sdk/dist (build the SDK first)
 *
 * Fences inside <ProviderTab> blocks are checked too: they sit unindented, like any fence.
 * Each page becomes its own small project under .snippets/<page>/. A fence whose
 * title looks like a file path (title="lib/sandbox.ts") is written to that path, so
 * pages can import between their own snippets ("@/lib/sandbox" maps to the page
 * root). Other fences become snippet-N.ts. Stub modules for local helpers such as
 * "./kv" come from scripts/snippet-stubs/. Opt a fence out with check="skip".
 *
 * The SDK and its optional peers (ai, zod, @mastra/core, @openai/agents) resolve
 * from packages/sdk, and hono from apps/docs, as they would from one deduplicated node_modules in an app.
 * Otherwise the workspace's second copy of `ai` gives snippets a different
 * `schemaSymbol` than the SDK's declarations, and valid tool maps fail to type-check.
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const docsDir = resolve(import.meta.dirname, "..");
const contentDir = join(docsDir, "content");
const outDir = join(docsDir, ".snippets");
const stubsDir = join(docsDir, "scripts", "snippet-stubs");
const sdkDir = resolve(docsDir, "../../packages/sdk");
const tsc = join(docsDir, "node_modules", ".bin", "tsc");

if (!existsSync(join(sdkDir, "dist"))) {
  console.error(
    "snippets: packages/sdk/dist does not exist. Build the SDK first: bun run --cwd packages/sdk build",
  );
  process.exit(1);
}

interface Snippet {
  file: string;
  line: number;
  lang: "ts" | "tsx";
  title: string | undefined;
  code: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return walk(path);

    return entry.name.endsWith(".mdx") ? [path] : [];
  });
}

const fence = /^```(ts|tsx)(?:[ \t]+([^\n]*))?\n([\s\S]*?)^```$/gm;

function extract(file: string): Snippet[] {
  const source = readFileSync(file, "utf8");
  const snippets: Snippet[] = [];

  for (const match of source.matchAll(fence)) {
    const [, lang, meta = "", code] = match;

    if (/\bcheck="skip"/.test(meta)) continue;
    const title = /title="([^"]+)"/.exec(meta)?.[1];
    const line = source.slice(0, match.index).split("\n").length;
    snippets.push({ file, line, lang: lang === "tsx" ? "tsx" : "ts", title, code: code ?? "" });
  }

  return snippets;
}

const isPath = (title: string | undefined): title is string =>
  title !== undefined && /^[\w@./-]+\.(ts|tsx)$/.test(title) && !title.startsWith("/");

function tsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        lib: ["ES2023", "ESNext.Disposable", "DOM"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
        paths: { "@/*": ["./*"] },
      },
      include: ["**/*.ts", "**/*.tsx"],
    },
    null,
    2,
  );
}

rmSync(outDir, { recursive: true, force: true });

mkdirSync(outDir, { recursive: true });

// Resolve the SDK through its package.json exports, as a user would, and share its peers.
const linkModule = (name: string, target: string) => {
  const path = join(outDir, "node_modules", name);
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "dir");
};

linkModule("@opencoredev/sandbox-sdk", sdkDir);

const sdkManifest: { peerDependencies?: Record<string, string> } = JSON.parse(
  readFileSync(join(sdkDir, "package.json"), "utf8"),
);

for (const peer of Object.keys(sdkManifest.peerDependencies ?? {})) {
  const installed = join(sdkDir, "node_modules", peer);

  if (existsSync(installed)) linkModule(peer, realpathSync(installed));
}

// Web frameworks the integration pages use. They aren't SDK peers, so they come from the docs package.
for (const name of ["hono"]) {
  const installed = join(docsDir, "node_modules", name);

  if (!existsSync(installed)) {
    console.error(`snippets: ${name} is not installed in apps/docs. Run bun install.`);
    process.exit(1);
  }

  linkModule(name, realpathSync(installed));
}

const origins = new Map<string, Snippet>();
const projects: string[] = [];

for (const file of walk(contentDir)) {
  const snippets = extract(file);

  if (snippets.length === 0) continue;

  const slug = relative(contentDir, file)
    .replace(/\.mdx$/, "")
    .replaceAll("/", "__");

  const projectDir = join(outDir, slug);
  mkdirSync(projectDir, { recursive: true });
  cpSync(stubsDir, projectDir, { recursive: true });
  writeFileSync(join(projectDir, "tsconfig.json"), tsconfig());

  snippets.forEach((snippet, index) => {
    const name = isPath(snippet.title) ? snippet.title : `snippet-${index + 1}.${snippet.lang}`;
    const target = join(projectDir, name);
    mkdirSync(dirname(target), { recursive: true });
    // `export {}` makes every snippet a module, so top-level await and `await using` are allowed.
    writeFileSync(target, `${snippet.code}\nexport {};\n`);
    origins.set(target, snippet);
  });
  projects.push(projectDir);
}

function typecheck(projectDir: string): Promise<{ status: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(tsc, ["-p", projectDir, "--pretty", "false"]);
    let output = "";
    child.stdout.on("data", (data: Buffer) => (output += data.toString()));
    child.stderr.on("data", (data: Buffer) => (output += data.toString()));
    child.on("close", (status) => done({ status, output }));
  });
}

// At most 4 tsc processes at once, to keep load on shared machines bounded.
const results: { projectDir: string; status: number | null; output: string }[] = [];
const queue = [...projects];

await Promise.all(
  Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let projectDir = queue.shift(); projectDir; projectDir = queue.shift()) {
      results.push({ projectDir, ...(await typecheck(projectDir)) });
    }
  }),
);

let failures = 0;

for (const { projectDir, status, output } of results) {
  if (status === 0) continue;
  failures += 1;

  // Map "path/snippet-2.ts(4,7): error" back to the .mdx file and line.
  for (const line of output.split("\n")) {
    const located = /^(.+?)\((\d+),(\d+)\): (.*)$/.exec(line);

    if (!located) {
      if (line.trim()) console.error(line);
      continue;
    }

    const [, path = "", row = "0", , message = ""] = located;
    const snippet = origins.get(resolve(projectDir, path)) ?? origins.get(resolve(path));

    if (!snippet) {
      console.error(line);
      continue;
    }

    const mdxLine = snippet.line + Number(row);
    console.error(`${relative(docsDir, snippet.file)}:${mdxLine}: ${message}`);
  }
}

const total = origins.size;
const mode = "packages/sdk/dist";

if (failures > 0) {
  console.error(
    `snippets: ${failures} of ${projects.length} page(s) failed to type-check against ${mode}.`,
  );
  process.exit(1);
}

console.log(
  `snippets: ${total} snippet(s) on ${projects.length} page(s) type-check against ${mode}.`,
);

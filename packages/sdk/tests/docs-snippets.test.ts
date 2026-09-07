import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const docsRoot = "../../apps/fumadocs/content/docs";

async function listMdx(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listMdx(path)));
    else if (entry.name.endsWith(".mdx")) files.push(path);
  }
  return files;
}

function extractCompleteSnippets(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```(?:ts|typescript)[^\n]*\n([\s\S]*?)```/g)];
  return blocks
    .map((match) => match[1]!.trim())
    .filter((code) => code.includes("import ") && code.includes("from "));
}

test("complete docs TypeScript snippets compile", async () => {
  const dir = join(process.cwd(), ".tmp-docs-snippets");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const snippets: { page: string; code: string }[] = [];
  for (const page of await listMdx(docsRoot)) {
    const markdown = await readFile(page, "utf8");
    for (const code of extractCompleteSnippets(markdown)) {
      snippets.push({ page, code });
    }
  }
  expect(snippets.length).toBeGreaterThan(0);
  for (const [index, snippet] of snippets.entries()) {
    const file = join(dir, `snippet-${index}.ts`);
    await writeFile(file, snippet.code);
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "build",
        "--target=bun",
        "--external",
        "eve",
        "--external",
        "@mastra/core",
        "--external",
        "ai",
        "--external",
        "@ai-sdk/harness",
        "--external",
        "@ai-sdk/harness-codex",
        "--external",
        "zod",
        file,
        "--outfile",
        join(dir, `snippet-${index}.mjs`),
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, `${snippet.page}\n${new TextDecoder().decode(result.stderr)}`).toBe(0);
  }
  await rm(dir, { recursive: true, force: true });
});

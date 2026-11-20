/**
 * The offline preload refuses every request that would leave the machine and fails the process
 * that made it, even when that process catches the error, so a test cannot pass while its
 * subprocess quietly tried the network.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { blockedExitCode, blockedMarker } from "./offline-preload.js";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "offline-preload-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run `source` under the preload, as the CLI tests run the CLI. */
async function run(name: string, source: string) {
  const file = join(dir, `${name}.ts`);
  await writeFile(file, source);

  const result = spawnSync("bun", ["--preload", "./tests/offline-preload.ts", file], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 20_000,
  });

  if (result.error) throw result.error;

  return result;
}

/** A loopback server answering `path` with `status` and an optional Location. */
const server = (routes: string) => `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const routes = ${routes};
    const route = routes[new URL(request.url).pathname] ?? [404];
    return new Response(route[2] ?? "", { status: route[0], headers: route[1] ? { location: route[1] } : {} });
  },
});
`;

it("a caught request to a public host still fails the process", async () => {
  const result = await run(
    "caught",
    `try { await fetch("https://example.invalid/data"); } catch {}\nconsole.log("done");\n`,
  );

  expect(result.stdout).toContain("done");
  expect(result.status).toBe(blockedExitCode);
  expect(result.stderr).toContain(blockedMarker);
  expect(result.stderr).toContain("https://example.invalid/data");
});

it("a loopback redirect to a public host is refused, not followed", async () => {
  const result = await run(
    "redirect-out",
    `${server(`{ "/go": [302, "https://external.invalid/landing"] }`)}
let outcome = "followed";
try { await fetch(\`\${server.url.origin}/go\`); } catch { outcome = "refused"; }
console.log(outcome);
server.stop(true);
`,
  );

  expect(result.stdout).toContain("refused");
  expect(result.status).toBe(blockedExitCode);
  expect(result.stderr).toContain("https://external.invalid/landing");
});

it("loopback redirects are followed and the optional egress lookup is answered offline", async () => {
  const result = await run(
    "redirect-loopback",
    `${server(`{ "/a": [302, "/b"], "/b": [200, null, "ok"] }`)}
const body = await (await fetch(\`\${server.url.origin}/a\`)).text();
const egress = (await fetch("https://ipinfo.io/json")).status;
console.log(body, egress);
server.stop(true);
`,
  );

  expect(result.stderr).not.toContain(blockedMarker);
  expect(result.stdout.trim()).toBe("ok 503");
  expect(result.status).toBe(0);
});

import {spawnSync} from "node:child_process";
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { checkAttempts, attemptPolicySchema } from "../src/attempts.js";
import { performanceScript } from "../src/perf-script.js";
it("fails missing counts, accepts only explicit not-run reasons", () => {
  const policy = attemptPolicySchema.parse({replacements: [], notRun: [{provider: "boat", suite: "main", scenario: "pause-resume", reason: "Unsupported"}]});
  const rows = checkAttempts([], policy);
  expect(rows.find(r => r.provider === "boat" && r.scenario === "pause-resume")?.pass).toBe(true);
  expect(rows.find(r => r.provider === "e2b" && r.scenario === "cold")?.pass).toBe(false);
  const wildcard = checkAttempts([], {replacements: [], notRun: [{provider: "boat", suite: "burst", scenario: "burst-25/*", reason: "Plan start limit"}]});
  expect(wildcard.find(r => r.provider === "boat" && r.scenario === "burst-25/all-ready")?.pass).toBe(true);
  expect(() => attemptPolicySchema.parse({replacements: [], notRun: [{provider: "boat", suite: "main", scenario: "cold", reason: ""}]})).toThrow();
});
it("omits CDN downloads while preserving TCP and fixed performance kernels", async () => {
  const raw = await readFile(new URL("../probes/perf.py", import.meta.url), "utf8");
  const script = performanceScript(raw, true);
  expect(script).not.toContain("speed.cloudflare.com");
  expect(script).toContain("socket.create_connection");
  expect(script).toContain("results['disk-4k-read-iops']");
  expect(performanceScript(raw, false)).toBe(raw);
  expect(() => performanceScript("changed", true)).toThrow();
});


it("executes the generated network probe without any CDN request when downloads are omitted", async () => {
  const raw = await readFile(new URL("../probes/perf.py", import.meta.url), "utf8");
  // Execute only the real network try-blocks, with transports intercepted. CPU/disk kernels never run.
  const harness = `import ast,sys,json,time,socket,urllib.request,contextlib
source=ast.parse(sys.stdin.read())
main=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='main')
urls=[];connections=[];results={};notes=[]
def download(request,**kwargs):
 urls.append(request.full_url)
 raise RuntimeError('CDN request intercepted')
def connect(address,**kwargs):
 connections.append(address)
 return contextlib.nullcontext()
urllib.request.urlopen=download
socket.create_connection=connect
exec(compile(ast.Module(body=[n for n in main.body if isinstance(n,ast.Try)],type_ignores=[]),'probe','exec'))
print(json.dumps({'urls':urls,'tcpConnections':len(connections)}))`;
  const run = (script: string) => {
    const result = spawnSync("python3", ["-c", harness], {input: script, encoding: "utf8", timeout: 5000});
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect(run(raw)).toEqual({urls: ["https://speed.cloudflare.com/__down?bytes=25000000"], tcpConnections: 5});
  expect(run(performanceScript(raw, true))).toEqual({urls: [], tcpConnections: 5});
});

it("requires ten cost attempts per track and keeps capability exclusions explicit", async () => {
  const {attemptTarget} = await import("../src/attempts.js");
  const {collectionPolicy} = await import("../src/collection-policy.js");
  expect(attemptTarget("cost", "tool-replay")).toBe(10);
  expect(attemptTarget("cost", "cold")).toBeNull();
  const rows = checkAttempts([], collectionPolicy(), ["same-spec"]);
  expect(rows.find(r => r.provider === "superserve" && r.suite === "cost")?.pass).toBe(true);
  expect(rows.find(r => r.provider === "daytona" && r.suite === "cost")).toMatchObject({pass: false, target: 10, reason: null});
});
it("rejects shared cost suites and oversized Boat quota windows", async () => {
  const {parseV2} = await import("../src/v2-config.js");
  expect(() => parseV2(["--scenarios", "cost,command"])).toThrow("must run alone");
  expect(() => parseV2(["--providers", "boat", "--scenarios", "cost", "--cost-runs", "11"])).toThrow("quota window");
  expect(parseV2(["--providers", "boat", "--scenarios", "cost"])["cost-runs"]).toBe(10);
});

it("keeps completed perf metrics when the real TCP probe catches a timeout", async () => {
  const raw = await readFile(new URL("../probes/perf.py", import.meta.url), "utf8");
  // Run the probe's real exception/output blocks, with no kernels or external connections.
  const harness = `import ast,sys,json,time,socket
source=ast.parse(sys.stdin.read())
main=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='main')
results={'cpu-single':7,'cpu-all':8,'memory-mbps':9,'disk-write-mbps':10,'disk-read-mbps':11,'disk-4k-write-iops':12,'disk-4k-read-iops':13};notes=[];n=2
def connect(*args,**kwargs):raise TimeoutError('timed out')
socket.create_connection=connect
blocks=[node for node in main.body if isinstance(node,ast.Try) or isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id=='print']
exec(compile(ast.Module(body=blocks,type_ignores=[]),'probe','exec'))`;
  const result = spawnSync("python3", ["-c", harness], {input: performanceScript(raw, true), encoding: "utf8", timeout: 5000});
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    metrics: {"cpu-single": 7, "cpu-all": 8, "memory-mbps": 9, "disk-write-mbps": 10, "disk-read-mbps": 11, "disk-4k-write-iops": 12, "disk-4k-read-iops": 13},
    notes: ["tcp-ms: timed out"],
  });
  expect(JSON.parse(result.stdout).metrics).not.toHaveProperty("tcp-ms");
});

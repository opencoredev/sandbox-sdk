/** Exercise the real railway SDK against in-memory GraphQL/WebSocket transports.
 * This catches flow-control and cancellation semantics that a shell mock cannot.
 */
import { afterEach, expect, test, vi } from "vitest";
import { railway } from "../src/providers/railway/index.js";
afterEach(() => vi.unstubAllGlobals());

test.each(["early", "blocked", "unconfirmed"] as const)("real Railway transport: %s stdin outcome", async mode => {
  let destroyed = 0;
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    const request: unknown = JSON.parse(String(init?.body));
    if (typeof request !== "object" || request === null || !("query" in request) || typeof request.query !== "string") throw new Error("Invalid GraphQL request");
    const query = request.query;
    if (query.includes("generateShellToken")) return Response.json({ data: { generateShellToken: "fake" } });
    if (query.includes("sandboxDestroy")) { destroyed++; return Response.json({ data: { sandboxDestroy: true } }); }
    if (query.includes("query RailwaySandbox(")) return Response.json({ data: { sandbox: { id: "fake", status: "RUNNING", domains: [], createdAt: new Date().toISOString(), environmentId: "env" } } });
    throw new Error("Unexpected GraphQL operation; network access is forbidden");
  });
  let connections = 0;
  class Wire {
    bufferedAmount = 0;
    // The first connection carries the command. Later ones are the tagged cleanup exec.
    readonly cleanup = connections++ > 0;
    onopen?: () => void;
    onmessage?: (event: { data: string | ArrayBuffer }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    frame(type: string, data: unknown) { this.onmessage?.({ data: JSON.stringify({ type, data }) }); }
    send(data: unknown) {
      if (typeof data !== "string") {
        if (mode === "early") setTimeout(() => {
          this.onmessage?.({ data: new Uint8Array([1, 120]).buffer });
          this.frame("exit", { exit_code: 0 });
        }, 0);
        return;
      }
      const frame: unknown = JSON.parse(data);
      if (typeof frame !== "object" || frame === null || !("type" in frame)) throw new Error("Invalid control frame");
      if (frame.type === "exec_hello") queueMicrotask(() => { this.frame("exec_capabilities", { version: 2, stdin_chunk_bytes: 16384, stdin_chunks: 1 }); if (this.cleanup) this.frame("exit", { exit_code: 0 }); });
      if (frame.type === "signal" && mode === "blocked") queueMicrotask(() => this.frame("exit", { exit_code: 143 }));
      if (frame.type === "signal" && mode === "unconfirmed") queueMicrotask(() => this.onclose?.({ code: 1006, reason: "lost" }));
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", Wire);
  const provider = railway({ token: "fake", environmentId: "env" });
  let output = "";
  const result = await provider.exec("fake", { command: "head -c 1", cwd: "/workspace", env: {}, stdin: "x".repeat(4 * 1024 * 1024), timeoutMs: 1000, onChunk: chunk => { output += chunk.text; } });
  expect(result).toEqual(mode === "early" ? { exitCode: 0, timedOut: false } : { exitCode: null, timedOut: true });
  // A lost confirmation runs a cleanup exec; the sandbox is never destroyed.
  expect(destroyed).toBe(0);
  expect(connections).toBe(mode === "unconfirmed" ? 2 : 1);
  expect(output).toBe(mode === "early" ? "x" : "");
});

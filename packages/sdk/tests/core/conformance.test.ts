import { expect, test } from "bun:test";
import { builtInProviderNames, defineAdapter } from "../../src";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider } from "../../src/core/provider";
import { memory } from "../../src/providers/memory";
import {
  requiredConformanceCases,
  runConformance,
  type ConformanceResult,
} from "../../src/testing";

const memoryCommands = {
  success: "true",
  stdout: "printf stdout",
  stderr: "printf stderr >&2",
  nonzero: "exit 2",
  timeout: "sleep 1",
  background: "sleep 1",
  stdin: "read value",
};

function assertRequiredPassed(results: ConformanceResult[]) {
  const required = new Set<string>(requiredConformanceCases);
  for (const result of results) {
    if (required.has(result.name)) {
      expect(result.status).toBe("passed");
    } else if (result.status === "skipped") {
      expect(result.reason).toBeTruthy();
    }
  }
  expect(results.filter((result) => result.status === "failed")).toEqual([]);
}

test("memory passes every required conformance case", async () => {
  const results = await runConformance({
    create: { provider: memory() },
    commands: memoryCommands,
  });
  assertRequiredPassed(results);
  expect(results.find((result) => result.name === "ports")?.reason).toContain("ports.expose");
});

test("a community adapter outside the built-in list passes required cases", async () => {
  const files = new Map<string, Uint8Array>();
  const provider: SandboxProvider<{ id: string }> = {
    id: "community-test",
    capabilities: defineCapabilities({
      "files.read": "memory",
      "files.write": "memory",
      "files.list": "memory",
      "files.remove": "memory",
      "process.run": "in-process",
    }),
    async create() {
      return {
        id: "community",
        raw: { id: "community" },
        capabilities: defineCapabilities({
          "files.read": "memory",
          "files.write": "memory",
          "files.list": "memory",
          "files.remove": "memory",
          "process.run": "in-process",
        }),
        files: {
          async write(path, value) {
            files.set(
              path,
              typeof value === "string" ? new TextEncoder().encode(value) : (value as Uint8Array),
            );
          },
          async read(path) {
            const data = files.get(path);
            if (!data) throw new Error(`not found: ${path}`);
            return data;
          },
          async list(path) {
            return [...files.keys()]
              .filter((entry) => entry.startsWith(`${path.replace(/\/$/, "")}/`) || entry === path)
              .map((entry) => ({
                name: entry.slice(entry.lastIndexOf("/") + 1),
                path: entry,
                type: "file" as const,
              }));
          },
          async mkdir() {},
          async remove(path) {
            files.delete(path);
            for (const entry of files.keys()) {
              if (entry.startsWith(`${path}/`)) files.delete(entry);
            }
          },
          async exists(path) {
            return files.has(path) || [...files.keys()].some((entry) => entry.startsWith(`${path}/`));
          },
        },
        async run(command, options) {
          const text = typeof command === "string" ? command : command.command;
          if (options?.timeout !== undefined && text.startsWith("sleep")) {
            throw Object.assign(new Error("timed out"), { code: "timeout" });
          }
          if (text === "true") return { stdout: "", stderr: "", exitCode: 0, success: true };
          if (text === "printf stdout")
            return { stdout: "stdout", stderr: "", exitCode: 0, success: true };
          if (text.includes("stderr"))
            return { stdout: "", stderr: "stderr", exitCode: 0, success: true };
          if (text === "exit 2") return { stdout: "", stderr: "", exitCode: 2, success: false };
          return { stdout: "", stderr: "", exitCode: 0, success: true };
        },
        async start() {
          throw new Error("unused");
        },
        async expose() {
          throw new Error("unused");
        },
        snapshots: {
          async create() {
            throw new Error("unused");
          },
          async delete() {},
          async restore() {},
        },
        async stop() {},
      };
    },
  };
  expect(builtInProviderNames.includes("community-test" as never)).toBe(false);
  const adapter = defineAdapter(provider);
  const results = await runConformance({
    create: { provider: adapter, cwd: "/workspace" },
    commands: memoryCommands,
  });
  expect(adapter.id).toBe("community-test");
  assertRequiredPassed(results);
});

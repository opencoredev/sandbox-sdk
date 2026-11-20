/**
 * Every rounds-based scenario, with one round's work reused for the rounds after it. Each test
 * failed against e1510e5, whose rounds all repeated the same input and whose verifier only checked
 * a round-indexed wrapper around one digest, so reused work passed.
 *
 * The guest programs run here as the sandbox runs them, with their round helper's call
 * `prepare(round)` pinned to round 0: every round then does real work, but on round 0's input.
 * The verifier must reject the reply at round 1. Like `expanded-bypasses.test.ts`, this file
 * imports only exports e1510e5 also had, so it runs against it unchanged.
 */
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory, type CommandHandler } from "@opencoredev/sandbox-sdk/memory";
import { describe, expect, it } from "vitest";
import {
  buildScenarios,
  gitProgram,
  httpProgram,
  pyBytecodeProgram,
  tsBundleProgram,
} from "../src/expanded/builds.js";
import {
  cpuScenarios,
  gzipGuestScript,
  sha256GuestScript,
  sieveGuestScript,
} from "../src/expanded/cpu.js";
import {
  filesystemScenarios,
  smallFilesProgram,
  sqliteProgram,
  tarProgram,
} from "../src/expanded/filesystem.js";
import { memProgram, runtimeScenarios, spawnProgram } from "../src/expanded/runtime.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import { runLocally, scenarioById, type GuestProgramCase } from "./expanded-verifier-suite.js";

const seed = 2_718_281_828;

const catalog: readonly ExpandedScenario[] = [
  ...cpuScenarios,
  ...filesystemScenarios,
  ...buildScenarios,
  ...runtimeScenarios,
];

/** `source` with every round of its round helper given round 0's input. */
function reuseRoundZero(source: string): string {
  return source
    .replace("await prepare(rounds.length)", "await prepare(0)")
    .replace("data = prepare(len(rounds))", "data = prepare(0)");
}

const guests: readonly (readonly [string, GuestProgramCase])[] = [
  ["cpu-sha256-hash", { source: sha256GuestScript, interpreter: "node" }],
  ["cpu-gzip-compress", { source: gzipGuestScript, interpreter: "node" }],
  ["cpu-prime-sieve", { source: sieveGuestScript, interpreter: "node" }],
  ["fs-small-files-500", { source: smallFilesProgram, interpreter: "node" }],
  ["fs-sqlite-oltp", { source: sqliteProgram, interpreter: "python3" }],
  ["fs-tar-extract-pack", { source: tarProgram, interpreter: "node" }],
  ["build-ts-strip-bundle", { source: tsBundleProgram, interpreter: "node" }],
  ["build-python-bytecode", { source: pyBytecodeProgram, interpreter: "python3" }],
  ["build-git-workflow", { source: gitProgram, interpreter: "node" }],
  ["build-http-server-load", { source: httpProgram, interpreter: "node" }],
  ["runtime-mem-alloc-128m", { source: memProgram, interpreter: "node" }],
  ["runtime-fork-spawn-100", { source: spawnProgram, interpreter: "node" }],
];

describe("rounds that reuse round 0's work fail verification", () => {
  // Each run fills at least a one-second timed window, plus the guest's setup.
  it.each(guests)("%s", { timeout: 60_000 }, (id, guest) => {
    const raw = runLocally({ ...guest, source: reuseRoundZero(guest.source) }, seed);

    expect(scenarioById(catalog, id).verifyOutput(raw, seed)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^round 1: /),
    });
  });

  it("cpu-gzip-compress: compressing only in the first round", { timeout: 60_000 }, () => {
    // The reviewer's case: every round still decompresses and hashes, but compresses only once.
    const source = gzipGuestScript.replace(
      /gzipSync\((\w+), \{ level: 6 \}\)/,
      "(globalThis.compressedOnce ??= gzipSync($1, { level: 6 }))",
    );

    expect(source).not.toBe(gzipGuestScript);

    const raw = runLocally({ source, interpreter: "node" }, seed);

    expect(scenarioById(catalog, "cpu-gzip-compress").verifyOutput(raw, seed)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^round 1: /),
    });
  });
});

describe("runtime-stdout-stream with stdout reused across rounds", () => {
  /** `cat` that answers after 50 ms, so a one-second window takes about 20 rounds. */
  function slowCat(reuseFirst: boolean): CommandHandler {
    let first: string | null = null;

    return async ({ args, files, stdout }) => {
      await new Promise((resolve) => setTimeout(resolve, 50));

      const parts = await Promise.all(args.map((path) => files.read(path)));
      const text = parts.map((part) => new TextDecoder().decode(part)).join("");

      first = reuseFirst ? (first ?? text) : text;
      stdout(first);

      return 0;
    };
  }

  /** Run the scenario on a memory sandbox whose `cat` is `cat`; `rm` and `mkdir` are no-ops. */
  async function runStream(cat: CommandHandler) {
    const provider = memory({ handlers: { rm: () => 0, mkdir: () => 0, cat } });
    const box = await createSandbox(provider);

    try {
      return await scenarioById(catalog, "runtime-stdout-stream").run(box, {
        seed,
        timeoutMs: 10_000,
      });
    } finally {
      await box.destroy();
    }
  }

  it("passes when every round streams its own bytes", { timeout: 30_000 }, async () => {
    const outcome = await runStream(slowCat(false));

    expect(outcome.value).toBeGreaterThan(0);
  });

  it("fails when later rounds get the first round's stdout", { timeout: 30_000 }, async () => {
    await expect(runStream(slowCat(true))).rejects.toThrow(/round 1/);
  });
});

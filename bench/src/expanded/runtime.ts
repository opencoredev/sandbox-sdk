/**
 * Runtime scenarios: memory allocation and page touching, process spawning, stdout streaming
 * through `box.run`, and the SDK's env, cwd, file and background-process contracts.
 *
 * Memory, spawn and stdout each take about 0.1 s, so they repeat in timed rounds (see
 * `rounds.ts`) for at least a second and report a rate over every round. The guest code is ours:
 * proofs catch a workload that silently did less or wrong work, not a malicious guest, so spawn
 * asks every child for its own pid, which only a real process can report.
 */
import type { RunResult, Sandbox } from "@opencoredev/sandbox-sdk";
import { z } from "zod";
import { command, quote } from "../workloads.js";
import {
  digestSchema,
  failure,
  nodePrelude,
  outcomeOf,
  parseGuestJson,
  proofOf,
  runGuestProgram,
  secondsSchema,
  seededHex,
  seedMismatch,
  seedSchema,
  sha256Hex,
} from "./guest-kit.js";
import {
  checkRounds,
  minTimedSeconds,
  nodeRoundsSource,
  perRound,
  proofIs,
  roundsSchema,
  type Round,
} from "./rounds.js";
import { memo } from "./verify-kit.js";
import type { ExpandedContext, ExpandedScenario, VerifyResult } from "./types.js";

const mebibyte = 1_048_576;
const bytesPerMegabyte = 1_000_000;

/** Minimum timed rounds for the memory, spawn and stdout scenarios. */
const runtimeMinRounds = 3;

// runtime-mem-alloc-128m

const memBytes = 128 * mebibyte;
const pageWords = 1024;
const memPages = memBytes / 4096;

/** Page `p`'s pattern: word `k` is `base + k * step` mod 2^32. */
function memPattern(seed: number, p: number) {
  return {
    base: Math.imul(seed ^ p, 0x9e3779b1) >>> 0,
    step: (Math.imul(p, 0x85ebca6b) | 1) >>> 0,
  };
}

/** The XOR of every word of every page's pattern: the same for any order of the pages. */
const memXor = memo((seed) => {
  let xor = 0;

  for (let p = 0; p < memPages; p++) {
    const { base, step } = memPattern(seed, p);

    for (let k = 0; k < pageWords; k++) xor ^= (base + Math.imul(k, step)) >>> 0;
  }

  return xor >>> 0;
});

/**
 * Round `round` fills page `p` with the pattern of page `(p + round) % pages`, so every round
 * writes different memory. Its digest folds an XOR over every word, which no rotation changes,
 * and an FNV-1a pass over one strided word per page in memory order, which every rotation
 * changes; the host computes both without allocating.
 */
const memRound = perRound((seed, round) => {
  let stride = 0x811c9dc5;

  for (let p = 0; p < memPages; p++) {
    const { base, step } = memPattern(seed, (p + round) % memPages);
    const k = (p * 7) & (pageWords - 1);
    stride = Math.imul(stride ^ ((base + Math.imul(k, step)) >>> 0), 16_777_619) >>> 0;
  }

  return sha256Hex(`${seed}:${memBytes}:${round}:${memXor(seed)}:${stride}`);
});

export function expectedMemDigest(seed: number, round = 0): string {
  return memRound(seed, round);
}

export const memProgram = `${nodePrelude}
${nodeRoundsSource}
const bytes = ${memBytes}, pages = bytes / 4096, words = ${pageWords};
let rssBytes = Number.MAX_SAFE_INTEGER;
const rounds = await timedRounds(${runtimeMinRounds}, (round) => round, (round) => {
  let mem = new Uint32Array(bytes / 4);
  for (let p = 0; p < pages; p++) {
    const q = (p + round) % pages;
    const base = Math.imul(SEED ^ q, 0x9e3779b1) >>> 0;
    const step = (Math.imul(q, 0x85ebca6b) | 1) >>> 0;
    const offset = p * words;
    for (let k = 0; k < words; k++) mem[offset + k] = (base + Math.imul(k, step)) >>> 0;
  }
  rssBytes = Math.min(rssBytes, process.memoryUsage().rss);
  let xor = 0;
  for (let i = 0; i < mem.length; i++) xor ^= mem[i];
  let stride = 0x811c9dc5;
  for (let p = 0; p < pages; p++) stride = Math.imul(stride ^ mem[p * words + ((p * 7) & (words - 1))], 16777619) >>> 0;
  mem = null;
  return { proof: sha(SEED + ":" + bytes + ":" + round + ":" + (xor >>> 0) + ":" + stride) };
});
console.log(JSON.stringify({ seed: SEED, bytes, rssBytes, rounds, digest: rounds[0].proof }));
`;

const memOutput = z.strictObject({
  seed: seedSchema,
  bytes: z.number().int(),
  rssBytes: z.number().int(),
  rounds: roundsSchema,
  digest: digestSchema,
});

export function verifyMem(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, memOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.bytes !== memBytes) return failure(`bytes ${out.bytes}, expected ${memBytes}`);

  // Every page was written, so the process held the whole working set resident in every round.
  if (out.rssBytes < memBytes) return failure(`rss ${out.rssBytes} below the working set`);

  if (out.digest !== expectedMemDigest(seed)) return failure("stride digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: runtimeMinRounds,
    check: proofIs((round) => expectedMemDigest(seed, round)),
  });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: (out.bytes * rounds.count) / bytesPerMegabyte / rounds.totalSeconds,
    proof: proofOf("runtime-mem", out.digest),
    details: {
      seconds: rounds.totalSeconds,
      rounds: rounds.count,
      rssMiB: Math.round(out.rssBytes / mebibyte),
    },
  };
}

// runtime-fork-spawn-100

const spawnCount = 100;

/** Child `i`'s token in round `round`: every round hands its children their own tokens. */
const spawnToken = (seed: number, round: number, i: number) =>
  seededHex(seed, "spawn", round, i).slice(0, 16);

const spawnRound = perRound((seed, round) =>
  sha256Hex(
    Array.from({ length: spawnCount }, (_, i) => `${i}:${spawnToken(seed, round, i)}\n`).join(""),
  ),
);

/** The digest of every child's line in round `round`. */
export function expectedSpawnDigest(seed: number, round = 0): string {
  return spawnRound(seed, round);
}

/**
 * Each child prints its index, its seeded token and its own pid (`$$`), and the guest checks that
 * pid against the one `spawnSync` started. Tokens alone come from the seed; pids only from
 * processes that ran, so the verifier wants 100 distinct child pids per round, none the parent's.
 */
export const spawnProgram = `${nodePrelude}
${nodeRoundsSource}
import { spawnSync } from "node:child_process";
const childPids = [];
const prepare = (round) => Array.from({ length: ${spawnCount} }, (_, i) => h("spawn", round, i).slice(0, 16));
const rounds = await timedRounds(${runtimeMinRounds}, prepare, (tokens) => {
  const outputs = [];
  const pids = [];
  for (let i = 0; i < ${spawnCount}; i++) {
    const token = tokens[i];
    const r = spawnSync("/bin/sh", ["-c", 'printf "%s:%s:%s\\\\n" "$1" "$2" "$$"', "sh", String(i), token], { encoding: "utf8" });
    const line = /^(\\d+):([0-9a-f]{16}):(\\d+)\\n$/.exec(r.stdout ?? "");
    if (r.status !== 0 || !line || line[1] !== String(i) || line[2] !== token) throw new Error("child " + i + " exited " + r.status + " with " + JSON.stringify(r.stdout));
    if (Number(line[3]) !== r.pid) throw new Error("child " + i + " reported pid " + line[3] + ", spawned " + r.pid);
    outputs.push(i + ":" + token + "\\n");
    pids.push(r.pid);
  }
  childPids.push(pids);
  return { proof: sha(outputs.join("")) };
});
console.log(JSON.stringify({ seed: SEED, spawns: ${spawnCount}, parentPid: process.pid, childPids, rounds, digest: rounds[0].proof }));
`;

const pidSchema = z.number().int().positive();

const spawnOutput = z.strictObject({
  seed: seedSchema,
  spawns: z.number().int(),
  parentPid: pidSchema,
  childPids: z.array(z.array(pidSchema)),
  rounds: roundsSchema,
  digest: digestSchema,
});

export function verifySpawn(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, spawnOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.spawns !== spawnCount) return failure(`spawns ${out.spawns}, expected ${spawnCount}`);

  if (out.digest !== expectedSpawnDigest(seed)) return failure("child output digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: runtimeMinRounds,
    check: proofIs((round) => expectedSpawnDigest(seed, round)),
  });

  if (!rounds.ok) return rounds;

  if (out.childPids.length !== rounds.count)
    return failure(`child pids for ${out.childPids.length} rounds, expected ${rounds.count}`);

  for (const [round, pids] of out.childPids.entries()) {
    const distinct = new Set(pids);

    if (pids.length !== spawnCount || distinct.size !== spawnCount)
      return failure(
        `round ${round}: ${distinct.size} distinct child pids, expected ${spawnCount}`,
      );

    if (distinct.has(out.parentPid)) return failure(`round ${round}: a child has the parent's pid`);
  }

  return {
    ok: true,
    value: (spawnCount * rounds.count) / rounds.totalSeconds,
    proof: proofOf("runtime-spawn", out.digest),
    details: { seconds: rounds.totalSeconds, rounds: rounds.count },
  };
}

// runtime-stdout-stream

/** About 512 KiB of lines, half the SDK's 1 MiB per-stream cap, so nothing is truncated. */
const streamLines = 7500;
const streamDir = "/workspace/bench-stream";

/** The seeded lines uploaded once; every round streams them behind its own salt line. */
export const expectedStream = memo((seed) =>
  Array.from({ length: streamLines }, (_, j) => `${j}:${seededHex(seed, "line", j)}\n`).join(""),
);

/** Round `round`'s first line, the same 70 bytes long every round. */
function streamSalt(seed: number, round: number): string {
  return `salt:${seededHex(seed, "stream-round", round)}\n`;
}

/** What round `round`'s `cat` must print: its salt line, then the uploaded lines. */
export function expectedStreamRound(seed: number, round: number): string {
  return `${streamSalt(seed, round)}${expectedStream(seed)}`;
}

const streamRoundDigest = perRound((seed, round) => sha256Hex(expectedStreamRound(seed, round)));

const streamOutput = z.strictObject({
  seed: seedSchema,
  lines: z.number().int(),
  bytes: z.number().int(),
  rounds: roundsSchema,
  digest: digestSchema,
});

/**
 * Raw output here is the host's record of repeated `box.run("cat ...")` calls: round 0's line and
 * byte counts and SHA-256 of the stdout it received, and each round's digest and host-measured
 * wall time.
 */
export function verifyStream(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, streamOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  const bytes = expectedStreamRound(seed, 0).length;

  if (out.lines !== streamLines + 1)
    return failure(`lines ${out.lines}, expected ${streamLines + 1}`);

  if (out.bytes !== bytes) return failure(`bytes ${out.bytes}, expected ${bytes}`);

  if (out.digest !== streamRoundDigest(seed, 0)) return failure("stdout digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: runtimeMinRounds,
    check: proofIs((round) => streamRoundDigest(seed, round)),
  });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: (out.bytes * rounds.count) / bytesPerMegabyte / rounds.totalSeconds,
    proof: proofOf("runtime-stream", out.digest),
    details: { seconds: rounds.totalSeconds, rounds: rounds.count, bytes: out.bytes },
  };
}

/** The first line that differs, for a precise failure message. */
function firstBadLine(received: string, expected: string) {
  const got = received.split("\n");
  const want = expected.split("\n");
  const index = want.findIndex((line, i) => got[i] !== line);

  return index === -1 ? `line count ${got.length}` : `line ${index}`;
}

async function runStream(box: Sandbox, ctx: ExpandedContext) {
  const path = `${streamDir}/lines.txt`;
  const saltPath = `${streamDir}/salt.txt`;

  await command(box, `rm -rf ${streamDir} && mkdir -p ${streamDir}`, ctx.timeoutMs);

  try {
    await box.files.write(path, expectedStream(ctx.seed));
    const rounds: Round[] = [];
    let spent = 0;
    let first = "";

    while (rounds.length < runtimeMinRounds || spent < minTimedSeconds) {
      // Untimed: the round's own first line, so every round streams different bytes.
      const expected = expectedStreamRound(ctx.seed, rounds.length);
      await box.files.write(saltPath, streamSalt(ctx.seed, rounds.length));

      const start = performance.now();
      const result = await box.run(`cat ${saltPath} ${path}`, { timeoutMs: ctx.timeoutMs });
      const seconds = (performance.now() - start) / 1000;

      if (!result.ok) throw new Error(`runtime-stdout-stream: cat exited ${result.exitCode}`);

      if (result.truncated) throw new Error("runtime-stdout-stream: stdout was truncated");

      if (result.stdout !== expected)
        throw new Error(
          `runtime-stdout-stream: round ${rounds.length} stdout differs at ${firstBadLine(result.stdout, expected)}`,
        );

      first ||= result.stdout;
      spent += seconds;
      rounds.push({ seconds, proof: sha256Hex(result.stdout) });
    }

    return JSON.stringify({
      seed: ctx.seed,
      lines: first.split("\n").length - 1,
      bytes: Buffer.byteLength(first),
      rounds,
      digest: sha256Hex(first),
    });
  } finally {
    await box.run(`rm -rf ${streamDir}`, { timeoutMs: ctx.timeoutMs });
  }
}

// runtime-env-isolation

const envChecks = 4;
const envDir = "/workspace/bench-env";

/** Inputs for the four checks, all derived from the seed. */
export function envInputs(seed: number) {
  const hex = seededHex(seed, "env");
  const binary = new Uint8Array(1024);

  // Every byte value once, in a seeded rotation, then seeded filler.
  for (let i = 0; i < 256; i++) binary[i] = (i + Number.parseInt(hex.slice(0, 2), 16)) & 0xff;

  for (let i = 256; i < binary.length; i++)
    binary[i] = Number.parseInt(seededHex(seed, "env-bin", i).slice(0, 2), 16);

  return {
    token: `tök ${hex.slice(0, 12)} "quoted" $HOME \`id\` =1 ✓`,
    cwd: `${envDir}/sub-${hex.slice(12, 20)}`,
    binary,
    text: `seed ${seed}: ünïcödé 日本語 😀 ${hex.slice(20, 44)}\nsecond line\n`,
    processName: `bench-env-${hex.slice(44, 52)}`,
  };
}

/** One result line per check, as `runEnv` builds them when every check passes. */
export function expectedEnvDigest(seed: number): string {
  const inputs = envInputs(seed);

  return sha256Hex(
    [
      `seed:${seed}`,
      `env:${sha256Hex(inputs.token)}:unset`,
      `cwd:${inputs.cwd}`,
      `files:${sha256Hex(inputs.binary)}:${sha256Hex(inputs.text)}`,
      "process:stopped",
    ].join("\n"),
  );
}

const envOutput = z.strictObject({
  seed: seedSchema,
  checksPassed: z.number().int(),
  seconds: secondsSchema,
  digest: digestSchema,
});

/** Raw output here is the host's record of the four checks and their host-measured time. */
export function verifyEnv(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, envOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.checksPassed !== envChecks)
    return failure(`checksPassed ${out.checksPassed}, expected ${envChecks}`);

  if (out.digest !== expectedEnvDigest(seed)) return failure("check digest mismatch");

  return {
    ok: true,
    value: out.seconds,
    proof: proofOf("runtime-env", out.digest),
    details: { checksPassed: out.checksPassed },
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function checkEnv(box: Sandbox, ctx: ExpandedContext, token: string) {
  const set = await box.run(`printf '%s' "$BENCH_TOKEN"`, {
    env: { BENCH_TOKEN: token },
    timeoutMs: ctx.timeoutMs,
  });

  if (!set.ok || set.stdout !== token)
    throw new Error(`env: got ${JSON.stringify(set.stdout)}, expected the token`);

  const unset = await command(box, `printf '%s' "\${BENCH_TOKEN-unset}"`, ctx.timeoutMs);

  if (unset !== "unset") throw new Error("env: BENCH_TOKEN leaked into a later command");

  return `env:${sha256Hex(set.stdout)}:${unset}`;
}

async function checkCwd(box: Sandbox, ctx: ExpandedContext, cwd: string) {
  await command(box, `mkdir -p ${quote(cwd)}`, ctx.timeoutMs);
  const absolute = await box.run("pwd", { cwd, timeoutMs: ctx.timeoutMs });

  const relative = await box.run("pwd", {
    cwd: cwd.replace(/^\/workspace\//, ""),
    timeoutMs: ctx.timeoutMs,
  });

  for (const result of [absolute, relative])
    if (!result.ok || result.stdout.trim() !== cwd || result.cwd !== cwd)
      throw new Error(`cwd: ran in ${result.stdout.trim()} (${result.cwd}), expected ${cwd}`);

  return `cwd:${cwd}`;
}

async function checkFiles(
  box: Sandbox,
  ctx: ExpandedContext,
  inputs: ReturnType<typeof envInputs>,
) {
  const binPath = `${envDir}/blob.bin`;
  const textPath = `${envDir}/text.txt`;

  await box.files.write(binPath, inputs.binary);
  await box.files.write(textPath, inputs.text);

  if (!sameBytes(await box.files.read(binPath, { as: "bytes" }), inputs.binary))
    throw new Error("files: binary readback differs");

  if ((await box.files.read(textPath)) !== inputs.text)
    throw new Error("files: UTF-8 readback differs");

  const sums = await command(box, `sha256sum ${binPath} ${textPath}`, ctx.timeoutMs);
  const guest = sums.split("\n").map((line) => line.split(/\s+/)[0]);
  const binHash = sha256Hex(inputs.binary);
  const textHash = sha256Hex(inputs.text);

  if (guest[0] !== binHash || guest[1] !== textHash)
    throw new Error("files: guest sha256sum differs from the bytes sent");

  return `files:${binHash}:${textHash}`;
}

/**
 * Prints `alive` while `pid` answers signal 0, `gone` once it neither answers nor has a /proc
 * entry, and `unknown` otherwise, such as a process the shell may not signal or a guest without
 * /proc.
 */
export function processProbe(pid: number): string {
  return `if kill -0 ${pid} 2>/dev/null; then echo alive; elif [ -r /proc/self/stat ] && [ ! -e /proc/${pid} ]; then echo gone; else echo unknown; fi`;
}

/**
 * The process check's result from the probe run after `stop()`. Only a probe that exited 0 and
 * printed `gone` shows the process stopped; a timeout, error or any other output proves nothing.
 */
export function stoppedVerdict(
  probe: Pick<RunResult, "ok" | "exitCode" | "timedOut" | "stdout">,
  pid: number,
): string {
  const marker = probe.ok ? probe.stdout.trim() : "";

  if (marker === "gone") return "process:stopped";

  if (marker === "alive") throw new Error(`process: pid ${pid} survived stop`);

  throw new Error(
    `process: could not tell whether pid ${pid} stopped (exit ${probe.exitCode}, timed out ${probe.timedOut}, output ${JSON.stringify(probe.stdout.slice(0, 80))})`,
  );
}

async function checkProcess(box: Sandbox, ctx: ExpandedContext, name: string) {
  const handle = await box.start("sleep 300", { name, cwd: envDir });

  try {
    const info = (await box.processes()).find((p) => p.name === name);

    if (!info || info.pid <= 0) throw new Error("process: background process not listed");

    await command(box, `kill -0 ${info.pid}`, ctx.timeoutMs);
    // stop() always waits the full grace before SIGKILL; keep it short so the SDK's round trips
    // dominate, not a fixed sleep.
    await handle.stop({ graceMs: 100 });
    const probe = await box.run(processProbe(info.pid), { timeoutMs: ctx.timeoutMs });

    return stoppedVerdict(probe, info.pid);
  } finally {
    if (handle.status === "running" || handle.status === "starting")
      await handle.stop({ graceMs: 0 }).catch(() => undefined);
  }
}

async function runEnv(box: Sandbox, ctx: ExpandedContext) {
  const inputs = envInputs(ctx.seed);

  await command(box, `rm -rf ${envDir} && mkdir -p ${envDir}`, ctx.timeoutMs);

  try {
    const start = performance.now();

    const results = [
      `seed:${ctx.seed}`,
      await checkEnv(box, ctx, inputs.token),
      await checkCwd(box, ctx, inputs.cwd),
      await checkFiles(box, ctx, inputs),
      await checkProcess(box, ctx, inputs.processName),
    ];

    const seconds = (performance.now() - start) / 1000;

    return JSON.stringify({
      seed: ctx.seed,
      checksPassed: results.length - 1,
      seconds,
      digest: sha256Hex(results.join("\n")),
    });
  } finally {
    await box.run(`rm -rf ${envDir}`, { timeoutMs: ctx.timeoutMs });
  }
}

export const runtimeScenarios: readonly ExpandedScenario[] = [
  {
    id: "runtime-mem-alloc-128m",
    category: "runtime",
    label: "128 MiB memory touch",
    description:
      "Allocate a 128 MiB working set, write every 4 KiB page with seeded words, then read it back with a full XOR pass and a strided checksum, in rounds for at least a second.",
    unit: "MB/s",
    better: "higher",
    verifyOutput: verifyMem,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        { dir: "/workspace/bench-mem", file: "mem.mjs", source: memProgram, interpreter: "node" },
        ctx,
      );

      return outcomeOf("runtime-mem-alloc-128m", verifyMem(raw, ctx.seed));
    },
  },
  {
    id: "runtime-fork-spawn-100",
    category: "runtime",
    label: "Spawn 100 processes",
    description:
      "Spawn 100 short-lived /bin/sh children one after another, each printing a seeded token and its own pid, and check every exit code, output and pid, in rounds for at least a second.",
    unit: "spawns/s",
    better: "higher",
    verifyOutput: verifySpawn,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        {
          dir: "/workspace/bench-spawn",
          file: "spawn.mjs",
          source: spawnProgram,
          interpreter: "node",
        },
        ctx,
      );

      return outcomeOf("runtime-fork-spawn-100", verifySpawn(raw, ctx.seed));
    },
  },
  {
    id: "runtime-stdout-stream",
    category: "runtime",
    label: "stdout streaming",
    description:
      "Stream 7,500 seeded lines (about 0.5 MB) through box.run stdout, in rounds for at least a second, and check every line arrived intact and untruncated.",
    unit: "MB/s",
    better: "higher",
    verifyOutput: verifyStream,
    async run(box, ctx) {
      return outcomeOf("runtime-stdout-stream", verifyStream(await runStream(box, ctx), ctx.seed));
    },
  },
  {
    id: "runtime-env-isolation",
    category: "runtime",
    label: "Env, cwd, files, processes",
    description:
      "Check per-command env and its isolation, absolute and relative cwd, binary and UTF-8 file round trips, and stopping a background process.",
    unit: "s",
    better: "lower",
    verifyOutput: verifyEnv,
    async run(box, ctx) {
      return outcomeOf("runtime-env-isolation", verifyEnv(await runEnv(box, ctx), ctx.seed));
    },
  },
];

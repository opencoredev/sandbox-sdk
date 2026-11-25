import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checks } from "../../src/fairness/cli.js";
import { guaranteedOverlap, groupErrors, notComparable } from "../../src/fairness/cpu-burst.js";
import {
  nativeChunkSteps,
  parseCpuFingerprint,
  summarizeSustained,
  verifyCheckpoints,
} from "../../src/fairness/cpu-native.js";
import {
  chooseDirectory,
  fsTypeName,
  parseCandidates,
  fits,
  summarizeDisk,
  verifyDisk,
} from "../../src/fairness/disk-real.js";
import { CheckStop, checkIds, entryFromLog, parseLog } from "../../src/fairness/framework.js";
import { lcgChecksum, workerSeed } from "../../src/sustained-cpu.js";
import {
  countCpuList,
  cpuView,
  judgeMemory,
  oomFileOf,
  type Liveness,
  lastPhase,
  parseLimits,
  parseOomKills,
} from "../../src/fairness/memory-honesty.js";
import {
  diskOutputSchema,
  diskRandomReadDigest,
  diskReadbackExpected,
  diskStampDigest,
  fmix32,
  memoryDigest,
  archOf,
  nativeBytes,
  parseNativeOutput,
  parsePlaced,
  xorshift32,
} from "../../src/fairness/native.js";
import { nativeBinaries } from "../../src/fairness/native-binary.js";
import {
  classifyIsolation,
  cmdlineFlags,
  kernelTokens,
  parseFirst,
  parseProbe,
  type IsolationFacts,
} from "../../src/fairness/security-probe.js";

const run = promisify(execFile);

describe("sbx-native binary", () => {
  it.each([
    ["x86_64", 0x3e],
    ["aarch64", 0xb7],
  ] as const)("the %s build is the static, interpreter-free ELF its hash says", (arch, machine) => {
    const bytes = Buffer.from(nativeBytes(arch));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(nativeBinaries[arch].sha256);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("\x7fELF");
    expect(bytes[4]).toBe(2); // 64-bit
    expect(bytes.readUInt16LE(18)).toBe(machine);
    const phoff = Number(bytes.readBigUInt64LE(0x20));
    const phentsize = bytes.readUInt16LE(0x36);
    const phnum = bytes.readUInt16LE(0x38);

    const types = Array.from({ length: phnum }, (_, i) =>
      bytes.readUInt32LE(phoff + i * phentsize),
    );

    expect(types).not.toContain(3); // PT_INTERP: no dynamic loader
    expect(types).not.toContain(2); // PT_DYNAMIC: no shared libraries
    expect(bytes.length).toBeLessThan(64 * 1024);
  });

  it("maps uname -m to a build", () => {
    expect(archOf("x86_64\n")).toBe("x86_64");
    expect(archOf("aarch64")).toBe("aarch64");
    expect(archOf("arm64")).toBe("aarch64");
    expect(archOf("riscv64")).toBeNull();
  });

  it("rebuilds to the same bytes with the same compilers", async () => {
    const gcc = await run("gcc", ["--version"]).catch(() => null);
    const clang = await run("clang", ["--version"]).catch(() => null);

    if (
      gcc?.stdout.split("\n")[0] !== nativeBinaries.x86_64.compiler ||
      clang?.stdout.split("\n")[0] !== nativeBinaries.aarch64.compiler
    )
      return;

    const native = new URL("../../native/", import.meta.url).pathname;

    // build.sh writes beside itself and into ../src/fairness; run a copy in a scratch tree.
    const tree = await mkdtemp(join(tmpdir(), "sbx-native-tree-"));
    await mkdir(join(tree, "native"));
    await mkdir(join(tree, "src", "fairness"), { recursive: true });
    await run("cp", [`${native}sbx-native.c`, `${native}build.sh`, join(tree, "native")]);
    await run("bash", [join(tree, "native", "build.sh")]);

    for (const [arch, file] of [
      ["x86_64", "sbx-native"],
      ["aarch64", "sbx-native-aarch64"],
    ] as const) {
      const built = await readFile(join(tree, "native", file));
      expect(createHash("sha256").update(built).digest("hex")).toBe(nativeBinaries[arch].sha256);
    }
  }, 60_000);

  it("matches the C arithmetic", () => {
    // murmur3's fmix32 reference values.
    expect(fmix32(0)).toBe(0);
    expect(fmix32(1)).toBe(0x514e28b7);
    expect(xorshift32(1)).toBe(270369);
    expect(diskStampDigest(7, 0)).toBe(0);
    expect(diskRandomReadDigest({ seed: 7, sizeMiB: 1, writeOps: 0, readOps: 0 })).toBe(0);
    expect(memoryDigest(9, 0)).toBe(0);
  });
});

describe("parseNativeOutput", () => {
  it("takes the last non-phase JSON line and recognizes the binary's error line", () => {
    const error = parseNativeOutput(
      '#phase start 0\n{"mode":"disk","error":"insufficient space","fsType":61267,"freeBytes":5}\n',
      diskOutputSchema,
    );

    expect(error).toEqual({
      kind: "error",
      error: { mode: "disk", error: "insufficient space", fsType: 61267, freeBytes: 5 },
    });
    expect(parseNativeOutput("Killed\n", diskOutputSchema).kind).toBe("invalid");
    expect(parseNativeOutput('{"mode":"disk"}', diskOutputSchema).kind).toBe("invalid");
  });

  it("reads where the installer put the binary", () => {
    expect(parsePlaced("path=/tmp/.sbx-native\nsha=abc\n")).toEqual({
      path: "/tmp/.sbx-native",
      sha: "abc",
    });
    expect(parsePlaced("path=/root/.sbx-native\nsha=\n")).toEqual({
      path: "/root/.sbx-native",
      sha: null,
    });
    expect(parsePlaced("")).toBeNull();
  });
});

const diskOutput = (seed: number, sizeMiB: number, ops: number, writeOps = 100) =>
  diskOutputSchema.parse({
    mode: "disk",
    fsType: 0xef53,
    freeBytes: 10 * 2 ** 30,
    sizeMiB,
    seqWrite: { direct: true, writeS: 1, syncS: 0.1 },
    seqRead: { direct: true, readS: 0.5, badPages: 0, stampDigest: diskStampDigest(seed, sizeMiB) },
    randWrite: { direct: true, wallS: 1, capped: false },
    randWriteLatency: { ops: writeOps, p50Ns: 200_000, p99Ns: 900_000, maxNs: 2_000_000 },
    randRead: {
      direct: true,
      wallS: 1,
      badPages: 0,
      digest: diskRandomReadDigest({ seed, sizeMiB, writeOps, readOps: ops }),
      capped: false,
    },
    randReadLatency: { ops, p50Ns: 80_000, p99Ns: 150_000, maxNs: 500_000 },
    readback: { badPages: 0, ...diskReadbackExpected({ seed, sizeMiB, writeOps }) },
  });

describe("disk-real", () => {
  it("accepts a consistent run and rejects tampered or impossible ones", () => {
    const output = diskOutput(11, 4, 50);
    expect(verifyDisk({ output, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 })).toEqual({
      kind: "ok",
    });
    expect(verifyDisk({ output, seed: 12, sizeMiB: 4, randomSeconds: 1, hostS: 10 }).kind).toBe(
      "invalid",
    );
    expect(verifyDisk({ output, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 2 })).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/inside a 2s exec/),
    });

    const bad = { ...output, seqRead: { ...output.seqRead, badPages: 3 } };
    expect(
      verifyDisk({ output: bad, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }).kind,
    ).toBe("invalid");

    const fewer = { ...output, randReadLatency: { ...output.randReadLatency, ops: 49 } };
    expect(
      verifyDisk({ output: fewer, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }),
    ).toMatchObject({
      reason: expect.stringMatching(/Random read digest/),
    });

    // A rewrite that never reached the disk: the reads saw the first version everywhere.
    const lost = {
      ...output,
      randRead: {
        ...output.randRead,
        digest: diskRandomReadDigest({ seed: 11, sizeMiB: 4, writeOps: 0, readOps: 50 }),
      },
    };

    expect(
      verifyDisk({ output: lost, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }).kind,
    ).toBe("invalid");

    const huge = { ...output, randReadLatency: { ...output.randReadLatency, ops: 10_000_000 } };
    expect(
      verifyDisk({ output: huge, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }),
    ).toMatchObject({ reason: expect.stringMatching(/outside 1 to/) });

    const instant = { ...output, seqRead: { ...output.seqRead, readS: 0 } };
    expect(
      verifyDisk({ output: instant, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }),
    ).toMatchObject({ reason: expect.stringMatching(/no time/) });

    const short = { ...output, randWrite: { ...output.randWrite, wallS: 0.2 } };
    expect(
      verifyDisk({ output: short, seed: 11, sizeMiB: 4, randomSeconds: 10, hostS: 30 }),
    ).toMatchObject({ reason: expect.stringMatching(/before its time/) });

    const disordered = {
      ...output,
      randReadLatency: { ...output.randReadLatency, p50Ns: 999_999 },
    };

    expect(
      verifyDisk({ output: disordered, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }).kind,
    ).toBe("invalid");
  });

  it("marks memory-backed or buffered runs not comparable", () => {
    const ext4 = summarizeDisk({ output: diskOutput(1, 4, 10), directory: "/root" });
    expect(ext4).toMatchObject({ comparable: true, notComparableWhy: null });

    const raw = diskOutput(1, 4, 10);

    const buffered = summarizeDisk({
      output: { ...raw, randRead: { ...raw.randRead, direct: false } },
      directory: "/root",
    });

    expect(buffered).toMatchObject({
      comparable: false,
      notComparableWhy: expect.stringMatching(/random read/),
    });
  });

  it("summarizes throughput, IOPS and the filesystem", () => {
    const result = summarizeDisk({
      output: { ...diskOutput(1, 4, 10), fsType: 0x01021994 },
      directory: "/root",
    });

    expect(result).toMatchObject({
      fsType: "tmpfs",
      memoryBacked: true,
      comparable: false,
      notComparableWhy: expect.stringMatching(/lived in memory/),
      seqWriteMiBps: 3.6,
      seqReadMiBps: 8,
      randWriteIops: 100,
      randWriteP50Us: 200,
      randReadP99Us: 150,
    });
    expect(fsTypeName(0x794c7630)).toBe("overlay");
    expect(fsTypeName(0x1234)).toBe("0x1234");
  });

  it("picks the roomiest writable directory that is not memory-backed", () => {
    const candidates = parseCandidates(
      "dir=/home/user avail=2000000 fs=ext2/ext3\ndir=/workspace avail=9000000 fs=overlayfs\ndir=/tmp avail=9000000 fs=ext2/ext3\ndir=/home/user avail=1 fs=ext2/ext3\n",
    );

    expect(candidates).toHaveLength(3);
    expect(chooseDirectory(candidates)).toEqual({
      dir: "/workspace",
      availKiB: 9_000_000,
      fs: "overlayfs",
    });
    expect(chooseDirectory([])).toBeNull();

    // A bigger tmpfs loses to a real disk; tmpfs is used only when it is all there is.
    const withTmpfs = parseCandidates(
      "dir=/root avail=1000 fs=ext2/ext3\ndir=/tmp avail=99000000 fs=tmpfs\n",
    );

    expect(chooseDirectory(withTmpfs)?.dir).toBe("/root");
    expect(chooseDirectory(parseCandidates("dir=/tmp avail=99 fs=tmpfs\n"))?.dir).toBe("/tmp");
    expect(fits(3 * 2 ** 20, 2048)).toBe(true);
    expect(fits(2 * 2 ** 20, 2048)).toBe(false);
  });
});

describe("memory-honesty", () => {
  it("reads a container that shows the host's CPUs over a 4-CPU quota", () => {
    const limits = parseLimits(
      [
        "nproc=48",
        "nprocAll=48",
        "cpuinfo=48",
        "allowed=0-47",
        "cpuMax=400000 100000",
        "memMax=8589934592",
        "swapMax=0",
        "memTotalKiB=395000000",
        "swapTotalKiB=0",
        "zram=0",
        "zswap=N",
        "overcommit=0",
      ].join("\n"),
    );

    expect(limits).toMatchObject({
      nproc: 48,
      affinityCpus: 48,
      quotaCpus: 4,
      quotaSource: "cgroup2",
      memLimitGiB: 8,
      swapTotalGiB: 0,
    });
    expect(cpuView(limits)).toEqual({ visible: 48, usable: 4, overReported: true });
  });

  it("takes the tightest quota of the cgroup walk and the affinity mask", () => {
    // The mount root says max; the shell's own cgroup holds the real 2-CPU limit.
    const nested = parseLimits(
      "nproc=8\nallowed=0-7\ncpuMax=200000 100000\ncpuMax=max 100000\nmemMax=4294967296\nmemMax=max\n",
    );

    expect(nested).toMatchObject({ quotaCpus: 2, memLimitGiB: 4 });
    expect(cpuView(nested)).toEqual({ visible: 8, usable: 2, overReported: true });

    // Two CPUs of affinity under a four-CPU quota: two usable.
    const pinned = parseLimits("nproc=2\nallowed=0-1\ncpuMax=400000 100000\n");
    expect(cpuView(pinned)).toEqual({ visible: 2, usable: 2, overReported: false });

    // Nothing readable: unknown, not "honest".
    expect(cpuView(parseLimits("")).overReported).toBeNull();
  });

  it("reads a VM without a quota, and cgroup v1", () => {
    const vm = parseLimits(
      "nproc=4\ncpuinfo=4\nallowed=0-3\ncpuMax=max 100000\nmemMax=max\nmemTotalKiB=8000000\n",
    );

    expect(vm).toMatchObject({ quotaCpus: null, quotaSource: "cgroup2", memLimitGiB: null });
    expect(cpuView(vm)).toEqual({ visible: 4, usable: 4, overReported: false });

    const v1 = parseLimits(
      "nproc=16\ncfsQuota=200000\ncfsPeriod=100000\nmemLimitV1=9223372036854771712\n",
    );

    expect(v1).toMatchObject({ quotaCpus: 2, quotaSource: "cgroup1", memLimitGiB: null });
    expect(cpuView(v1).overReported).toBe(true);

    const unlimitedV1 = parseLimits("nproc=4\ncfsQuota=-1\ncfsPeriod=100000\n");
    expect(unlimitedV1).toMatchObject({ quotaCpus: null, quotaSource: "cgroup1" });
  });

  it("counts CPU lists and reads kill evidence", () => {
    expect(countCpuList("0-3,8,10-11")).toBe(7);
    expect(countCpuList("")).toBeNull();
    expect(countCpuList("3-1")).toBeNull();
    expect(lastPhase("#phase start 0\n#phase filled 2.1\nKilled")).toBe("filled");
    expect(lastPhase("")).toBeNull();
    expect(parseOomKills("low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n")).toBe(1);
  });
});

const facts = (overrides: Partial<IsolationFacts>): IsolationFacts => ({
  kernel: "Linux 6.1.0 x86_64",
  cmdline: null,
  dmesg: [],
  sysVendor: null,
  productName: null,
  hypervisorFlag: true,
  markers: [],
  pid1: "init",
  pid1Cgroup: ["0::/"],
  detectVirt: null,
  detectContainer: null,
  ...overrides,
});

describe("security-probe", () => {
  it("names the isolation layer from its evidence", () => {
    expect(classifyIsolation(facts({ dmesg: ["[   0.000000] Starting gVisor..."] })).kind).toBe(
      "gvisor",
    );
    expect(classifyIsolation(facts({ markers: ["dockerenv"] })).kind).toBe("container");
    expect(classifyIsolation(facts({ pid1Cgroup: ["0::/kubepods/besteffort/pod1"] })).kind).toBe(
      "container",
    );
    expect(
      classifyIsolation(facts({ sysVendor: "Cloud Hypervisor", productName: "cloud-hypervisor" }))
        .kind,
    ).toBe("cloud-hypervisor");
    expect(
      classifyIsolation(
        facts({
          cmdline: "console=ttyS0 reboot=k panic=1 pci=off virtio_mmio.device=4K@0xd0000000:5",
        }),
      ).kind,
    ).toBe("microvm");
    expect(classifyIsolation(facts({ dmesg: ["Firecracker microVM"] })).kind).toBe("firecracker");
    expect(classifyIsolation(facts({ detectVirt: "kvm" })).kind).toBe("vm");
    expect(classifyIsolation(facts({ markers: ["dockerenv"] })).insideVm).toBe(true);
    expect(classifyIsolation(facts({ hypervisorFlag: null })).evidence[0]).toMatch(/not readable/);
    expect(classifyIsolation(facts({ sysVendor: "QEMU", productName: "Standard PC" })).kind).toBe(
      "qemu-kvm",
    );
    expect(classifyIsolation(facts({ sysVendor: "Amazon EC2" })).kind).toBe("vm");
    expect(classifyIsolation(facts({ hypervisorFlag: false })).kind).toBe("unknown");
  });

  it("flags mitigations turned off and notable tuning, exactly", () => {
    expect(
      cmdlineFlags(
        "console=ttyS0 spec_rstack_overflow=off init_on_free=0 cpuidle_haltpoll.force=1 mitigations=auto nopti",
      ),
    ).toEqual({
      weakening: ["spec_rstack_overflow=off", "init_on_free=0", "nopti"],
      notable: ["cpuidle_haltpoll.force=1"],
    });
    expect(cmdlineFlags("")).toEqual({ weakening: [], notable: [] });
    // Dashes count as underscores; anything after `--` is init's, not the kernel's.
    expect(cmdlineFlags("init-on-alloc=0 -- mitigations=off").weakening).toEqual([
      "init-on-alloc=0",
    ]);
  });

  it("parses the probe's sections", () => {
    const stdout = [
      "@@uname",
      "Linux 6.1.102 x86_64",
      "@@version",
      "Linux version 6.1.102 (gcc 12)",
      "@@cmdline",
      "console=ttyS0 reboot=k panic=1 pci=off virtio_mmio.device=4K@0xd0000000:5 init_on_free=0",
      "@@vulnerabilities",
      "meltdown=Not affected",
      "spec_rstack_overflow=Vulnerable: Safe RET, no microcode",
      "spectre_v2=Mitigation: Retpolines",
      "@@cpuinfo",
      "vendor_id\t: AuthenticAMD",
      "cpu family\t: 25",
      "model\t\t: 33",
      "model name\t: AMD EPYC",
      "stepping\t: 0",
      "microcode\t: 0xa201016",
      "cpu MHz\t\t: 3393.624",
      "hypervisorFlag=1",
      "@@user",
      "uid=0",
      "user=root",
      "sudo=no",
      "@@status",
      "CapEff:\t000001ffffffffff",
      "Seccomp:\t0",
      "NoNewPrivs:\t0",
      "@@dmi",
      "@@dmesg",
      "@@pid1",
      "comm=init",
      "cgroup=0::/",
      "@@markers",
      "rootfs=ext2/ext3",
    ].join("\n");

    const parsed = parseProbe(stdout);
    expect(parsed.isolation.kind).toBe("microvm");
    expect(parsed.weakeningFlags).toEqual(["init_on_free=0"]);
    expect(parsed.vulnerableCount).toBe(1);
    expect(parsed.cpu).toEqual({
      vendor: "AuthenticAMD",
      family: 25,
      model: 33,
      stepping: 0,
      modelName: "AMD EPYC",
      microcode: "0xa201016",
      mhz: 3393.624,
      hypervisorFlag: true,
    });
    expect(parsed).toMatchObject({
      uid: 0,
      user: "root",
      passwordlessSudo: false,
      seccomp: 0,
      rootFs: "ext2/ext3",
    });
  });

  it("keeps missing evidence unknown", () => {
    const partial = parseProbe("@@uname\nLinux 6.1 x86_64\n");
    expect(partial.vulnerableCount).toBeNull();
    expect(partial.cpu.hypervisorFlag).toBeNull();
  });

  it("reads the first command's uptime and boot ID", () => {
    expect(parseFirst("12.34 40.00\nboot=0f8fad5b-d9cb-469f-a165-70867728950e\n")).toEqual({
      uptimeS: 12.34,
      bootId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
    expect(parseFirst("")).toEqual({ uptimeS: null, bootId: null });
  });
});

describe("cpu checks", () => {
  it("bounds the burns' shared time by each host window", () => {
    // Burns of 10 s inside [0, 11] and [1, 12]: both certainly ran over [2, 10].
    expect(
      guaranteedOverlap([
        { startS: 0, endS: 11, guestS: 10 },
        { startS: 1, endS: 12, guestS: 10 },
      ]),
    ).toBe(8);
    // A burn that waited 30 s to start shares nothing provable.
    expect(
      guaranteedOverlap([
        { startS: 0, endS: 10.5, guestS: 10 },
        { startS: 0, endS: 40, guestS: 10 },
      ]),
    ).toBeLessThan(0);
    expect(guaranteedOverlap([])).toBeNull();
    // A guest that claims more time than its host window cannot add overlap.
    expect(guaranteedOverlap([{ startS: 0, endS: 100, guestS: 101 }])).toBe(100);
    expect(
      notComparable({
        requested: 10,
        created: 10,
        verified: 10,
        overlapS: 100,
        cohortSeconds: 120,
      }),
    ).toBeNull();
    expect(
      notComparable({ requested: 10, created: 2, verified: 2, overlapS: 10, cohortSeconds: 120 }),
    ).toBe("2 of 10 sandboxes created; burns provably overlapped 10 s of 120 s");
    expect(groupErrors(["a", "b", "a"])).toEqual([
      { error: "a", count: 2 },
      { error: "b", count: 1 },
    ]);
  });

  it("summarizes the sustained phase like sustained-cpu", () => {
    const segments = Array.from({ length: 30 }, (_, i) => ({
      segment: i + 1,
      minute: (i + 1) / 2,
      opsPerSec: i < 20 ? 100 : 16,
      perWorker: [],
      guestS: 30,
      hostS: 30.1,
    }));

    expect(summarizeSustained(segments, { segments: 30, seconds: 30, workers: 4 })).toEqual({
      first3MinOps: 100,
      last3MinOps: 16,
      retention: 0.16,
      minOverFirst: 0.16,
    });
    expect(
      summarizeSustained(segments.slice(0, 10), { segments: 30, seconds: 30, workers: 4 })
        .last3MinOps,
    ).toBeNull();
  });

  it("reads the CPU fingerprint", () => {
    expect(parseCpuFingerprint("nproc=4\nmodel=AMD EPYC 9B14\n")).toEqual({
      guestVcpus: 4,
      cpuModel: "AMD EPYC 9B14",
    });
    expect(parseCpuFingerprint("")).toEqual({ guestVcpus: null, cpuModel: null });
  });
});

describe("check registry", () => {
  it("files every check under its own ID", () => {
    for (const id of checkIds) expect(checks[id].id).toBe(id);
  });
});

describe("second review regressions", () => {
  const memRaw = (overrides: Record<string, number>) =>
    JSON.stringify({
      mode: "mem",
      mib: 16,
      fillS: 0.1,
      fileMiB: 4,
      fileWrittenMiB: 4,
      fileS: 0.05,
      fileErrno: 0,
      verifyS: 0.1,
      badWords: 0,
      digest: memoryDigest(3, 16),
      rssFilledKiB: 1,
      swapFilledKiB: 0,
      rssAfterFileKiB: 1,
      swapAfterFileKiB: 0,
      end: { vmRssKiB: 1, vmSwapKiB: 0, memAvailableKiB: 1, swapFreeKiB: 0 },
      ...overrides,
    });

  const judge = (stdout: string) =>
    judgeMemory({
      run: { kind: "returned", exitCode: 0, timedOut: false, stdout, stderr: "" },
      seed: 3,
      memoryMiB: 16,
      fileMiB: 4,
      oomDelta: 0,
      liveness: { kind: "present" },
    });

  it("calls a sandbox lost only on confirmed absence", () => {
    const failed = (run: Parameters<typeof judgeMemory>[0]["run"], liveness: Liveness) => () =>
      judgeMemory({ run, seed: 3, memoryMiB: 16, fileMiB: 4, oomDelta: null, liveness });

    const threw = { kind: "threw", detail: "502 Bad Gateway" } as const;

    const exited = {
      kind: "returned",
      exitCode: 1,
      timedOut: false,
      stdout: "#phase filled 1\n",
      stderr: "",
    } as const;

    const unknown = { kind: "unavailable", detail: "probe failed" } as const;
    const gone = { kind: "absent", detail: "e2b:native-exact-get: not-found" } as const;

    for (const run of [threw, exited]) {
      expect(failed(run, unknown)).toThrow(CheckStop);
      expect(failed(run, unknown)).toThrow(/state is unknown/);
      expect(failed(run, { kind: "present" })).toThrow(CheckStop);
      expect(failed(run, gone)()).toMatchObject({ kind: "sandbox-lost" });
    }
  });

  it("calls a run whose file failed file-failed, never completed", () => {
    expect(judge(memRaw({})).kind).toBe("completed");
    expect(judge(memRaw({ fileErrno: 20, fileWrittenMiB: 0, fileS: 0 }))).toMatchObject({
      kind: "file-failed",
      errno: 20,
      writtenMiB: 0,
    });
    expect(judge(memRaw({ fileWrittenMiB: 2 }))).toMatchObject({
      kind: "file-failed",
      errno: null,
      writtenMiB: 2,
    });
  });

  it("recovers a log as clean only when its last sweep was", () => {
    const at = "2026-11-24T00:00:00Z";

    const lines = parseLog(
      [
        { kind: "start", check: "security-probe", provider: "e2b", runId: "r", attemptId: "a", at },
        { kind: "sandbox", id: "x", createS: 1, at },
        { kind: "destroy", sandboxId: "x", ok: true, attempts: 1, error: null, at },
        { kind: "sweep", found: [], destroyed: [], error: null, at },
        { kind: "sweep", found: ["late"], destroyed: [], error: "Could not destroy late", at },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );

    const machine = { cpu: 4, memoryGiB: 8, sameSize: true };
    expect(
      entryFromLog({ check: "security-probe", provider: "e2b", machine, lines })?.destroyed,
    ).toBe(false);
  });

  it("takes the numerically tightest swap limit", () => {
    expect(parseLimits("swapMax=1073741824\nswapMax=536870912\nswapMax=max\n").swapLimit).toBe(
      "536870912",
    );
    expect(parseLimits("swapMax=max\n").swapLimit).toBe("max");
  });

  it("ignores virtio-mmio after the init separator", () => {
    expect(
      classifyIsolation({ ...facts({}), cmdline: "console=ttyS0 -- virtio_mmio.device=4K@0x1:5" })
        .kind,
    ).toBe("vm");
  });

  it("rejects a capped phase without the cap's count", () => {
    const output = diskOutput(11, 4, 50);
    const fakeCap = { ...output, randRead: { ...output.randRead, capped: true, wallS: 0.01 } };
    expect(
      verifyDisk({ output: fakeCap, seed: 11, sizeMiB: 4, randomSeconds: 10, hostS: 30 }).kind,
    ).toBe("invalid");
  });

  it("stamps every random write with its own version", () => {
    const base = { seed: 5, sizeMiB: 1, readOps: 2000 };
    // More writes change what the reads must see, even where pages repeat.
    expect(diskRandomReadDigest({ ...base, writeOps: 2000 })).not.toBe(
      diskRandomReadDigest({ ...base, writeOps: 1999 }),
    );
  });
});

describe("third review regressions", () => {
  it("fails a run whose synced random write was lost, even if no timed read hit it", () => {
    const output = diskOutput(11, 4, 50);
    const expected = diskReadbackExpected({ seed: 11, sizeMiB: 4, writeOps: 100 });
    expect(expected.pages).toBeGreaterThan(0);
    expect(verifyDisk({ output, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }).kind).toBe(
      "ok",
    );

    // The disk kept the first version of one rewritten page: the readback digest moves off.
    const lost = {
      ...output,
      readback: { ...output.readback, digest: (output.readback.digest + 1) >>> 0 },
    };

    expect(
      verifyDisk({ output: lost, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }),
    ).toMatchObject({ reason: expect.stringMatching(/rewritten pages/) });

    const fewer = { ...output, readback: { ...output.readback, pages: output.readback.pages - 1 } };
    expect(
      verifyDisk({ output: fewer, seed: 11, sizeMiB: 4, randomSeconds: 1, hostS: 10 }).kind,
    ).toBe("invalid");
  });

  const phase = { segments: 2, seconds: 1, workers: 2 };

  const checkpoint = (seed: number, segment: number, steps: number, elapsedS: number) =>
    JSON.stringify({
      mode: "cpu-stream",
      segment,
      elapsedS,
      scanS: 0.0001,
      workers: [0, 1].map((index) => {
        const s = workerSeed(seed, index);

        return { seed: s, steps, checksum: lcgChecksum(s, steps) };
      }),
    });

  it("verifies a continuous burn's checkpoints against the seed and the host's clock", () => {
    const steps = nativeChunkSteps * 10;
    const stdout = `${checkpoint(7, 1, steps, 1.01)}\n${checkpoint(7, 2, steps * 2, 2.02)}\n{"mode":"cpu-stream","done":true,"wallS":2.03}\n`;

    const seen = new Map([
      [1, 1.5],
      [2, 2.5],
    ]);

    const ok = verifyCheckpoints({ stdout, seed: 7, phase, firstSeenS: seen });
    expect(ok.kind).toBe("ok");

    if (ok.kind === "ok") {
      expect(ok.done).toBe(true);
      expect(ok.segments).toHaveLength(2);
      expect(ok.segments[1]?.opsPerSec).toBe(Math.round((2 * steps) / 1.01));
    }

    // A checkpoint the host saw before the guest says it got there.
    expect(
      verifyCheckpoints({
        stdout,
        seed: 7,
        phase,
        firstSeenS: new Map([
          [1, 1.5],
          [2, 0.5],
        ]),
      }).kind,
    ).toBe("invalid");
    // A wrong seed's checksum.
    expect(verifyCheckpoints({ stdout, seed: 8, phase, firstSeenS: seen }).kind).toBe("invalid");
    // A partial last line is ignored, not failed.
    expect(
      verifyCheckpoints({
        stdout: `${checkpoint(7, 1, steps, 1.01)}\n{"mode":"cpu`,
        seed: 7,
        phase,
        firstSeenS: seen,
      }),
    ).toMatchObject({ kind: "ok", done: false });
  });

  it("tokenizes the kernel command line with its quoting", () => {
    expect(
      kernelTokens('BOOT_IMAGE="/boot/image -- rescue" mitigations=off -- init_on_free=0'),
    ).toEqual(["BOOT_IMAGE=/boot/image -- rescue", "mitigations=off"]);
    expect(cmdlineFlags('BOOT_IMAGE="/boot/image -- rescue" mitigations=off').weakening).toEqual([
      "mitigations=off",
    ]);
  });

  it("recovers a log as destroyed only from the stop record's own verdict", () => {
    const at = "2026-11-24T00:00:00Z";
    const machine = { cpu: 4, memoryGiB: 8, sameSize: true };

    const lines = (stop: { destroyed: boolean; cleanupError: string | null }) =>
      parseLog(
        [
          {
            kind: "start",
            check: "security-probe",
            provider: "e2b",
            runId: "r",
            attemptId: "a",
            at,
          },
          { kind: "sweep", found: [], destroyed: [], error: null, at },
          { kind: "stop", status: "failed", reason: "x", at, ...stop },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );

    expect(
      entryFromLog({
        check: "security-probe",
        provider: "e2b",
        machine,
        lines: lines({ destroyed: false, cleanupError: "1 create(s) still in flight after 300s" }),
      }),
    ).toMatchObject({ destroyed: false, cleanupError: "1 create(s) still in flight after 300s" });
    expect(
      entryFromLog({
        check: "security-probe",
        provider: "e2b",
        machine,
        lines: lines({ destroyed: true, cleanupError: null }),
      })?.destroyed,
    ).toBe(true);
  });
});

describe("fourth review regressions", () => {
  it("rejects a window much shorter than a segment", () => {
    const steps = nativeChunkSteps * 10;
    const phase = { segments: 2, seconds: 1, workers: 1 };
    const s = workerSeed(7, 0);

    const row = (segment: number, n: number, elapsedS: number) =>
      JSON.stringify({
        mode: "cpu-stream",
        segment,
        elapsedS,
        scanS: 0.0001,
        workers: [{ seed: s, steps: n, checksum: lcgChecksum(s, n) }],
      });

    const stdout = `${row(1, steps, 3.0)}\n${row(2, steps + nativeChunkSteps, 3.003)}\n`;
    expect(verifyCheckpoints({ stdout, seed: 7, phase, firstSeenS: new Map() })).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/covers 0.003s/),
    });
  });

  it("compares OOM counters only with a device and inode", () => {
    expect(oomFileOf("oomFile=/sys/fs/cgroup/memory.events 41:1234\n")).toBe(
      "/sys/fs/cgroup/memory.events 41:1234",
    );
    expect(oomFileOf("oomFile=/sys/fs/cgroup/memory.events \n")).toBeNull();
  });

  it("keeps a cleanup the sweep finished as destroyed", () => {
    const at = "2026-11-24T00:00:00Z";

    const lines = parseLog(
      [
        { kind: "start", check: "security-probe", provider: "e2b", runId: "r", attemptId: "a", at },
        { kind: "sandbox", id: "x", createS: 1, at },
        { kind: "destroy", sandboxId: "x", ok: false, attempts: 3, error: "timed out", at },
        { kind: "sweep", found: ["x"], destroyed: ["x"], error: null, at },
        { kind: "stop", status: "failed", reason: "x", destroyed: true, cleanupError: null, at },
      ]
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );

    expect(
      entryFromLog({
        check: "security-probe",
        provider: "e2b",
        machine: { cpu: 4, memoryGiB: 8, sameSize: true },
        lines,
      }),
    ).toMatchObject({ destroyed: true, cleanupError: null });
  });
});

describe("sixth review regressions", () => {
  it("scores a late-starting worker over the common window, not its own", () => {
    // One worker starts 120 s late: it adds nothing in the first windows, so the sandbox's rate there
    // is the other three's, and the late one's steps count only in the windows it ran.
    const phase = { segments: 2, seconds: 60, workers: 2 };
    const rate = nativeChunkSteps; // steps per second per running worker
    const s0 = workerSeed(7, 0);
    const s1 = workerSeed(7, 1);

    const row = (segment: number, a: number, b: number) =>
      JSON.stringify({
        mode: "cpu-stream",
        segment,
        elapsedS: segment * 60,
        scanS: 0.0001,
        workers: [
          { seed: s0, steps: a, checksum: lcgChecksum(s0, a) },
          { seed: s1, steps: b, checksum: lcgChecksum(s1, b) },
        ],
      });

    const stdout = `${row(1, rate * 60, 0)}\n${row(2, rate * 120, 0)}\n`;
    const check = verifyCheckpoints({ stdout, seed: 7, phase, firstSeenS: new Map() });
    expect(check.kind).toBe("ok");

    if (check.kind === "ok") expect(check.segments.map((x) => x.opsPerSec)).toEqual([rate, rate]);
  });
});

describe("seventh review regressions", () => {
  it("rejects a checkpoint whose scan of the workers took too long", () => {
    const phase = { segments: 1, seconds: 1, workers: 1 };
    const s0 = workerSeed(7, 0);
    const n = nativeChunkSteps * 10;
    const stdout = `${JSON.stringify({ mode: "cpu-stream", segment: 1, elapsedS: 1.0, scanS: 0.18, workers: [{ seed: s0, steps: n, checksum: lcgChecksum(s0, n) }] })}\n`;
    expect(verifyCheckpoints({ stdout, seed: 7, phase, firstSeenS: new Map() })).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/to sample/),
    });
  });
});

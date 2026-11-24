import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checks } from "../../src/fairness/cli.js";
import { guaranteedOverlap, groupErrors, notComparable } from "../../src/fairness/cpu-burst.js";
import { parseCpuFingerprint, summarizeSustained } from "../../src/fairness/cpu-native.js";
import {
  chooseDirectory,
  fsTypeName,
  parseCandidates,
  fits,
  summarizeDisk,
  verifyDisk,
} from "../../src/fairness/disk-real.js";
import { checkIds } from "../../src/fairness/framework.js";
import {
  countCpuList,
  cpuView,
  lastPhase,
  parseLimits,
  parseOomKills,
} from "../../src/fairness/memory-honesty.js";
import {
  diskOutputSchema,
  diskRandomReadDigest,
  diskStampDigest,
  fmix32,
  memoryDigest,
  nativeBytes,
  parseNativeOutput,
  parsePlaced,
  xorshift32,
} from "../../src/fairness/native.js";
import { nativeCompiler, nativeSha256 } from "../../src/fairness/native-binary.js";
import {
  classifyIsolation,
  cmdlineFlags,
  parseFirst,
  parseProbe,
  type IsolationFacts,
} from "../../src/fairness/security-probe.js";

const run = promisify(execFile);

describe("sbx-native binary", () => {
  it("is the static, interpreter-free x86_64 ELF its hash says", () => {
    const bytes = Buffer.from(nativeBytes());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(nativeSha256);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("\x7fELF");
    expect(bytes[4]).toBe(2); // 64-bit
    expect(bytes.readUInt16LE(18)).toBe(0x3e); // x86-64
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

  it("rebuilds to the same bytes with the same compiler", async () => {
    const gcc = await run("gcc", ["--version"]).catch(() => null);

    if (gcc === null || gcc.stdout.split("\n")[0] !== nativeCompiler) return;
    const work = await mkdtemp(join(tmpdir(), "sbx-native-build-"));
    const source = new URL("../../native/sbx-native.c", import.meta.url).pathname;
    const output = join(work, "sbx-native");

    await run("gcc", [
      "-std=c11",
      "-O2",
      "-march=x86-64",
      "-mtune=generic",
      "-static",
      "-nostdlib",
      "-ffreestanding",
      "-fno-builtin",
      "-fno-stack-protector",
      "-fno-pie",
      "-no-pie",
      "-fno-tree-loop-distribute-patterns",
      "-fno-asynchronous-unwind-tables",
      "-fcf-protection=none",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-Wl,--build-id=none",
      "-Wl,-z,noexecstack",
      "-s",
      "-o",
      output,
      source,
    ]);
    await run("objcopy", ["--remove-section", ".comment", output]);
    const built = await readFile(output);
    expect(createHash("sha256").update(built).digest("hex")).toBe(nativeSha256);
  });

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

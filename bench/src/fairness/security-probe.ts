/**
 * security-probe: the same read-only questions asked of every provider's fresh sandbox. Nothing is
 * changed in the guest and nothing outside it is contacted.
 *
 * - The first command after create reads /proc/uptime and the boot ID, so the host can compare the
 *   guest's uptime with how long the create took (a sandbox booted long before it was asked for
 *   came from a pool or a snapshot, which is how fast starts are made; it is not hidden).
 * - Isolation layer: gVisor, Firecracker, Cloud Hypervisor, QEMU/KVM or another hypervisor, or a
 *   container, from the kernel, DMI, the kernel command line, dmesg and PID 1, with the evidence.
 * - The kernel command line's security-relevant flags, /sys/devices/system/cpu/vulnerabilities/*,
 *   the CPU's vendor, family, model and clock, and whether commands run as root.
 */
import { z } from "zod";
import { sanitize } from "../v2-runner.js";
import { CheckStop, type Check } from "./framework.js";

export const firstCommand = `cat /proc/uptime 2>/dev/null; echo "boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"`;

export function parseFirst(stdout: string) {
  const uptime = Number(/^(\d+(?:\.\d+)?)\s/m.exec(stdout)?.[1] ?? Number.NaN);
  const boot = /^boot=([0-9a-f-]{36})$/m.exec(stdout)?.[1] ?? null;

  return { uptimeS: Number.isFinite(uptime) ? uptime : null, bootId: boot };
}

export const probeSections = [
  "uname",
  "version",
  "cmdline",
  "vulnerabilities",
  "cpuinfo",
  "user",
  "status",
  "dmi",
  "dmesg",
  "pid1",
  "markers",
  "end",
] as const;

/** Each section is `@@<name>` then its lines; the parser keeps them apart. */
export const probeCommand = [
  `echo "@@uname"; uname -srm 2>/dev/null`,
  `echo "@@version"; cat /proc/version 2>/dev/null`,
  `echo "@@cmdline"; cat /proc/cmdline 2>/dev/null`,
  `echo "@@vulnerabilities"; for f in /sys/devices/system/cpu/vulnerabilities/*; do [ -r "$f" ] && echo "$(basename "$f")=$(cat "$f" 2>/dev/null)"; done`,
  `echo "@@cpuinfo"; grep -m1 '^vendor_id' /proc/cpuinfo; grep -m1 '^cpu family' /proc/cpuinfo; grep -m1 '^model[[:space:]]*:' /proc/cpuinfo; grep -m1 '^model name' /proc/cpuinfo; grep -m1 '^stepping' /proc/cpuinfo; grep -m1 '^microcode' /proc/cpuinfo; grep -m1 '^cpu MHz' /proc/cpuinfo; f=$(grep -m1 '^flags' /proc/cpuinfo 2>/dev/null); if [ -n "$f" ]; then echo "hypervisorFlag=$(echo "$f" | grep -cw hypervisor)"; fi`,
  `echo "@@user"; echo "uid=$(id -u 2>/dev/null)"; echo "user=$(id -un 2>/dev/null)"; if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then echo "sudo=yes"; else echo "sudo=no"; fi`,
  `echo "@@status"; grep -E '^(CapEff|Seccomp|NoNewPrivs):' /proc/self/status 2>/dev/null`,
  `echo "@@dmi"; for k in sys_vendor product_name bios_vendor; do [ -r /sys/class/dmi/id/$k ] && echo "$k=$(cat /sys/class/dmi/id/$k 2>/dev/null)"; done; [ -r /sys/hypervisor/type ] && echo "hypervisor=$(cat /sys/hypervisor/type)"`,
  `echo "@@dmesg"; dmesg 2>/dev/null | head -8`,
  `echo "@@pid1"; echo "comm=$(cat /proc/1/comm 2>/dev/null)"; head -3 /proc/1/cgroup 2>/dev/null | sed 's/^/cgroup=/'`,
  `echo "@@markers"; [ -e /.dockerenv ] && echo dockerenv; [ -e /run/.containerenv ] && echo containerenv; [ -e /dev/kvm ] && echo devkvm; command -v systemd-detect-virt >/dev/null 2>&1 && echo "detectVirt=$(systemd-detect-virt 2>/dev/null)" && echo "detectContainer=$(systemd-detect-virt -c 2>/dev/null)"; echo "rootfs=$(stat -f -c %T / 2>/dev/null)"`,
  `echo "@@end"`,
].join("\n");

export function sections(stdout: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;

  for (const line of stdout.split("\n")) {
    const header = /^@@(\w+)$/.exec(line);

    if (header?.[1]) {
      current = [];
      out.set(header[1], current);
    } else if (current !== null && line.trim() !== "") current.push(line.trim());
  }

  return out;
}

const keyValues = (lines: readonly string[] | undefined, separator: RegExp) => {
  const out = new Map<string, string>();

  for (const line of lines ?? []) {
    const match = separator.exec(line);

    if (match?.index !== undefined && match.index > 0)
      out.set(line.slice(0, match.index).trim(), line.slice(match.index + match[0].length).trim());
  }

  return out;
};

/**
 * Kernel parameters that turn a CPU or kernel mitigation off, or memory hardening down. `value`
 * null matches the bare flag. Both directions are recorded, not judged: some trade security
 * margin for speed, which a buyer may want to know.
 */
export const mitigationFlags: readonly { readonly name: string; readonly value: string | null }[] =
  [
    { name: "mitigations", value: "off" },
    { name: "nopti", value: null },
    { name: "pti", value: "off" },
    { name: "kpti", value: "0" },
    { name: "nospectre_v1", value: null },
    { name: "nospectre_v2", value: null },
    { name: "spectre_v2", value: "off" },
    { name: "spectre_v2_user", value: "off" },
    { name: "spectre_bhi", value: "off" },
    { name: "nospec_store_bypass_disable", value: null },
    { name: "spec_store_bypass_disable", value: "off" },
    { name: "l1tf", value: "off" },
    { name: "mds", value: "off" },
    { name: "tsx_async_abort", value: "off" },
    { name: "mmio_stale_data", value: "off" },
    { name: "retbleed", value: "off" },
    { name: "spec_rstack_overflow", value: "off" },
    { name: "srbds", value: "off" },
    { name: "gather_data_sampling", value: "off" },
    { name: "reg_file_data_sampling", value: "off" },
    { name: "init_on_free", value: "0" },
    { name: "init_on_alloc", value: "0" },
    { name: "randomize_kstack_offset", value: "off" },
    { name: "nokaslr", value: null },
  ];

/** Performance-oriented parameters worth showing beside the mitigations. */
export const notableFlags = ["cpuidle_haltpoll.force", "idle", "nosmt", "isolcpus", "nohz_full"];

/** The kernel treats `-` and `_` in a parameter name alike. */
const normalName = (name: string) => name.replaceAll("-", "_");

/** Kernel parameters only: everything after a bare `--` goes to init, not the kernel. */
export function kernelTokens(cmdline: string): string[] {
  // As the kernel parses it: double quotes group a value with spaces and are dropped, and a bare
  // unquoted `--` ends the kernel's own parameters.
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let wasQuoted = false;

  const push = () => {
    if (current === "" && !wasQuoted) return;
    tokens.push(current);
    current = "";
    wasQuoted = false;
  };

  for (const char of cmdline) {
    if (char === '"') {
      quoted = !quoted;
      wasQuoted = true;
    } else if (!quoted && /\s/.test(char)) {
      if (current === "--" && !wasQuoted) return tokens;
      push();
    } else current += char;
  }

  if (current === "--" && !wasQuoted) return tokens;
  push();

  return tokens;
}

export function cmdlineFlags(cmdline: string) {
  const tokens = kernelTokens(cmdline);

  const parsed = tokens.map((token) => {
    const at = token.indexOf("=");

    return at < 0
      ? { name: normalName(token), value: null, token }
      : { name: normalName(token.slice(0, at)), value: token.slice(at + 1), token };
  });

  const weakening = parsed
    .filter((p) => mitigationFlags.some((f) => f.name === p.name && f.value === p.value))
    .map((p) => p.token);

  const notable = parsed.filter((p) => notableFlags.includes(p.name)).map((p) => p.token);

  return { weakening, notable };
}

export const isolationKinds = [
  "gvisor",
  "firecracker",
  "microvm",
  "cloud-hypervisor",
  "qemu-kvm",
  "vm",
  "container",
  "unknown",
] as const;

export type IsolationKind = (typeof isolationKinds)[number];

export type IsolationFacts = {
  readonly kernel: string | null;
  readonly cmdline: string | null;
  readonly dmesg: string[];
  readonly sysVendor: string | null;
  readonly productName: string | null;
  /** Null when /proc/cpuinfo has no flags line to read. */
  readonly hypervisorFlag: boolean | null;
  readonly markers: string[];
  readonly pid1: string | null;
  readonly pid1Cgroup: string[];
  readonly detectVirt: string | null;
  readonly detectContainer: string | null;
};

/**
 * The isolation layer and why: the first rule that matches wins, most specific first. `insideVm`
 * is for a container whose CPU also reports a hypervisor: a container inside a VM.
 */
export interface Isolation {
  readonly kind: IsolationKind;
  readonly evidence: string[];
  readonly insideVm: boolean | null;
}

export function classifyIsolation(facts: IsolationFacts): Isolation {
  const evidence: string[] = [];
  const dmesg = facts.dmesg.join("\n");
  const vendor = `${facts.sysVendor ?? ""} ${facts.productName ?? ""}`.trim();

  if (/gVisor/i.test(dmesg) || facts.detectVirt === "gvisor") {
    evidence.push(/gVisor/i.test(dmesg) ? "dmesg names gVisor" : "systemd-detect-virt: gvisor");

    return { kind: "gvisor", evidence, insideVm: null };
  }

  const containerMarkers = facts.markers.filter((m) => m === "dockerenv" || m === "containerenv");

  const containerCgroup = facts.pid1Cgroup.some((line) =>
    /docker|kubepods|containerd|libpod|lxc/.test(line),
  );

  const detectedContainer =
    facts.detectContainer !== null &&
    facts.detectContainer !== "" &&
    facts.detectContainer !== "none";

  if (containerMarkers.length > 0 || containerCgroup || detectedContainer) {
    if (containerMarkers.length > 0) evidence.push(`${containerMarkers.join(", ")} present`);

    if (containerCgroup) evidence.push("PID 1's cgroup is a container runtime's");

    if (detectedContainer) evidence.push(`systemd-detect-virt -c: ${facts.detectContainer}`);

    if (facts.hypervisorFlag)
      evidence.push("the CPU also reports a hypervisor, so the container runs in a VM");

    return { kind: "container", evidence, insideVm: facts.hypervisorFlag };
  }

  if (/cloud hypervisor/i.test(vendor)) {
    evidence.push(`DMI: ${vendor}`);

    return { kind: "cloud-hypervisor", evidence, insideVm: null };
  }

  if (/firecracker/i.test(vendor) || /firecracker/i.test(dmesg)) {
    evidence.push(/firecracker/i.test(vendor) ? `DMI: ${vendor}` : "dmesg names Firecracker");

    return { kind: "firecracker", evidence, insideVm: null };
  }

  const kernelArgs = kernelTokens(facts.cmdline ?? "");

  if (kernelArgs.some((t) => t.startsWith("virtio_mmio.device=")) && facts.sysVendor === null) {
    evidence.push(
      "virtio-mmio devices on the kernel command line and no DMI table: a microVM layout, as Firecracker's and QEMU's microvm machine use",
    );

    return { kind: "microvm", evidence, insideVm: null };
  }

  if (/qemu/i.test(vendor) || facts.detectVirt === "qemu") {
    evidence.push(vendor ? `DMI: ${vendor}` : `systemd-detect-virt: ${facts.detectVirt}`);

    return { kind: "qemu-kvm", evidence, insideVm: null };
  }

  if (facts.hypervisorFlag || (facts.detectVirt !== null && facts.detectVirt !== "none")) {
    if (facts.hypervisorFlag) evidence.push("CPU reports the hypervisor flag");

    if (vendor) evidence.push(`DMI: ${vendor}`);

    if (facts.detectVirt) evidence.push(`systemd-detect-virt: ${facts.detectVirt}`);

    return { kind: "vm", evidence, insideVm: null };
  }

  evidence.push(
    facts.hypervisorFlag === null
      ? "the CPU flags were not readable, and there was no DMI table or container marker"
      : "no hypervisor flag, DMI table or container marker",
  );

  return { kind: "unknown", evidence, insideVm: null };
}

export const securityResultSchema = z.object({
  createS: z.number(),
  uptimeAtFirstCommandS: z.number().nullable(),
  /**
   * A lower bound on how long before the create call the guest booted: its uptime minus the host's
   * seconds from the create call to the first command's reply (which is at least as long as from
   * the create to when the command ran). Near 0 or negative: booted for this create.
   */
  bootedBeforeCreateS: z.number().nullable(),
  /** The kernel's boot ID: the same in two sandboxes means one kernel (a clone, or a shared host). */
  bootId: z.string().nullable(),
  isolation: z.object({
    kind: z.enum(isolationKinds),
    evidence: z.array(z.string()),
    insideVm: z.boolean().nullable(),
  }),
  kernel: z.string().nullable(),
  /** Only allowlisted kernel parameters: the raw command line can carry boot secrets. */
  weakeningFlags: z.array(z.string()),
  notableFlags: z.array(z.string()),
  vulnerabilities: z.array(z.object({ name: z.string(), status: z.string() })),
  /** Null when the kernel lists no vulnerability files: unknown, not zero. */
  vulnerableCount: z.number().int().nonnegative().nullable(),
  cpu: z.object({
    vendor: z.string().nullable(),
    family: z.number().int().nullable(),
    model: z.number().int().nullable(),
    stepping: z.number().int().nullable(),
    modelName: z.string().nullable(),
    microcode: z.string().nullable(),
    mhz: z.number().nullable(),
    hypervisorFlag: z.boolean().nullable(),
  }),
  uid: z.number().int().nullable(),
  user: z.string().nullable(),
  passwordlessSudo: z.boolean(),
  capEff: z.string().nullable(),
  seccomp: z.number().int().nullable(),
  noNewPrivs: z.number().int().nullable(),
  dmi: z.object({ sysVendor: z.string().nullable(), productName: z.string().nullable() }),
  rootFs: z.string().nullable(),
});

export type SecurityResult = z.infer<typeof securityResultSchema>;

const int = (text: string | undefined) => {
  if (text === undefined || !/^-?\d+$/.test(text)) return null;

  return Number(text);
};

const textOrNull = (text: string | undefined) => (text === undefined || text === "" ? null : text);

export function parseProbe(stdout: string) {
  const parts = sections(stdout);
  const first = (name: string) => parts.get(name)?.[0] ?? null;
  const cpu = keyValues(parts.get("cpuinfo"), /\s*[:=]\s*/);
  const user = keyValues(parts.get("user"), /=/);
  const status = keyValues(parts.get("status"), /:\s*/);
  const dmi = keyValues(parts.get("dmi"), /=/);
  const pid1Lines = parts.get("pid1") ?? [];
  const markers = parts.get("markers") ?? [];
  const markerValues = keyValues(markers, /=/);
  const cmdline = first("cmdline");

  const vulnerabilities = (parts.get("vulnerabilities") ?? []).flatMap((line) => {
    const at = line.indexOf("=");

    return at > 0 ? [{ name: line.slice(0, at), status: line.slice(at + 1) }] : [];
  });

  const mhz = Number(cpu.get("cpu MHz") ?? Number.NaN);

  const facts: IsolationFacts = {
    kernel: first("uname"),
    cmdline,
    dmesg: parts.get("dmesg") ?? [],
    sysVendor: textOrNull(dmi.get("sys_vendor")),
    productName: textOrNull(dmi.get("product_name")),
    hypervisorFlag: cpu.has("hypervisorFlag") ? cpu.get("hypervisorFlag") === "1" : null,
    markers: markers.filter((m) => !m.includes("=")),
    pid1: textOrNull(pid1Lines.find((l) => l.startsWith("comm="))?.slice(5)),
    pid1Cgroup: pid1Lines.filter((l) => l.startsWith("cgroup=")).map((l) => l.slice(7)),
    detectVirt: textOrNull(markerValues.get("detectVirt")),
    detectContainer: textOrNull(markerValues.get("detectContainer")),
  };

  const flags = cmdlineFlags(cmdline ?? "");

  return {
    facts,
    isolation: classifyIsolation(facts),
    kernel: facts.kernel,
    weakeningFlags: flags.weakening,
    notableFlags: flags.notable,
    vulnerabilities,
    vulnerableCount:
      vulnerabilities.length === 0
        ? null
        : vulnerabilities.filter((v) => /^Vulnerable/i.test(v.status)).length,
    cpu: {
      vendor: textOrNull(cpu.get("vendor_id")),
      family: int(cpu.get("cpu family")),
      model: int(cpu.get("model")),
      stepping: int(cpu.get("stepping")),
      modelName: textOrNull(cpu.get("model name")),
      microcode: textOrNull(cpu.get("microcode")),
      mhz: Number.isFinite(mhz) ? mhz : null,
      hypervisorFlag: facts.hypervisorFlag,
    },
    uid: int(user.get("uid")),
    user: textOrNull(user.get("user")),
    passwordlessSudo: user.get("sudo") === "yes",
    capEff: textOrNull(status.get("CapEff")),
    seccomp: int(status.get("Seccomp")),
    noNewPrivs: int(status.get("NoNewPrivs")),
    dmi: { sysVendor: facts.sysVendor, productName: facts.productName },
    rootFs: textOrNull(markerValues.get("rootfs")),
  };
}

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

export const securityProbe: Check<SecurityResult> = {
  id: "security-probe",
  boxes: 1,
  minBoxes: 1,
  lifetimeMs: 15 * 60_000,
  resultSchema: securityResultSchema,
  async run(context) {
    const created = context.boxes[0];

    if (!created) throw new CheckStop("No sandbox");
    const sent = performance.now();
    const firstRun = await context.exec(created.box, firstCommand, 60_000);
    const returned = performance.now();
    const first = parseFirst(firstRun.stdout);

    // Host seconds from the create call to the reply, which bounds how long the guest could have
    // been up if it booted for this request.
    const sinceCreateS = created.createS + (returned - created.readyAtMs) / 1000;

    await context.note("first", { ...first, sinceCreateS, execS: (returned - sent) / 1000 });
    const probe = await context.exec(created.box, probeCommand, 120_000);

    // Every section must be there: a probe cut short would read as missing findings.
    const missing = probeSections.filter((name) => !sections(probe.stdout).has(name));

    if (probe.timedOut || !probe.ok || missing.length > 0)
      throw new CheckStop(
        `Probe ${probe.timedOut ? "timed out" : `exited ${probe.exitCode}`} without ${missing.join(", ") || "finishing"}: ${sanitize(probe.stderr).slice(0, 200)}`,
      );
    const parsed = parseProbe(probe.stdout);
    // The raw kernel command line and dmesg can carry boot secrets: the log keeps only the other facts
    // and what was derived from those two (the isolation evidence, the allowlisted flags).
    const { cmdline: _cmdline, dmesg: _dmesg, ...facts } = parsed.facts;
    await context.note("facts", facts);
    context.say(
      `${parsed.isolation.kind}; ${parsed.cpu.modelName ?? "cpu ?"}; uptime ${first.uptimeS ?? "?"}s after ${round(sinceCreateS, 1)}s; ${parsed.vulnerableCount} vulnerable`,
    );

    return {
      createS: round(created.createS, 3),
      uptimeAtFirstCommandS: first.uptimeS,
      bootedBeforeCreateS: first.uptimeS === null ? null : round(first.uptimeS - sinceCreateS, 1),
      bootId: first.bootId,
      isolation: parsed.isolation,
      kernel: parsed.kernel,
      weakeningFlags: parsed.weakeningFlags,
      notableFlags: parsed.notableFlags,
      vulnerabilities: parsed.vulnerabilities,
      vulnerableCount: parsed.vulnerableCount,
      cpu: parsed.cpu,
      uid: parsed.uid,
      user: parsed.user,
      passwordlessSudo: parsed.passwordlessSudo,
      capEff: parsed.capEff,
      seccomp: parsed.seccomp,
      noNewPrivs: parsed.noNewPrivs,
      dmi: parsed.dmi,
      rootFs: parsed.rootFs,
    };
  },
};

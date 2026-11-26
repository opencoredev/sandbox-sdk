/**
 * The guest capability probe (guest/probe.sh) and what it says about running services. The probe
 * prints facts only; whether a daemon really works is decided by the compose path actually starting
 * one (attempt.ts), never by these facts alone.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const probeScript = readFileSync(new URL("./guest/probe.sh", import.meta.url), "utf8");

const yesNo = z.enum(["yes", "no"]);

/** The probe's facts. Unknown or garbled values stay strings so nothing is invented. */
export const probeSchema = z.object({
  uid: z.string(),
  user: z.string(),
  arch: z.string(),
  kernel: z.string(),
  os: z.string(),
  libc: z.string(),
  sudo: z.enum(["root", "passwordless", "no"]),
  virt: z.string(),
  gvisor: yesNo,
  hypervisorFlag: yesNo,
  dmiVendor: z.string(),
  dmiProduct: z.string(),
  containerMarker: z.string(),
  pid1: z.string(),
  kvmDevice: z.enum(["rw", "present", "none"]),
  vmxSvm: yesNo,
  capEff: z.string(),
  capSysAdmin: yesNo.optional(),
  capNetAdmin: yesNo.optional(),
  seccomp: z.string(),
  noNewPrivs: z.string(),
  cgroupFs: z.string(),
  cgroupControllers: z.string(),
  cgroupWritable: yesNo,
  overlayFs: yesNo,
  fuseDevice: yesNo,
  iptables: z.string(),
  nft: yesNo,
  userns: z.string(),
  maxUserNamespaces: z.string(),
  newuidmap: yesNo,
  subuid: yesNo,
  dockerCli: z.string(),
  dockerInfo: z.enum(["yes", "sudo", "no"]),
  dockerd: yesNo,
  dockerSocket: yesNo,
  composePlugin: z.string(),
  podman: z.string(),
  podmanInfo: yesNo,
  containerd: yesNo,
  node: z.string(),
  setpriv: yesNo,
  libstdcxx: yesNo,
  aptGet: yesNo,
  curl: yesNo,
  tmpFreeMb: z.string(),
  rootFreeMb: z.string(),
  memTotalMb: z.string(),
  nproc: z.string(),
  dockerHub: z.string(),
});

export type Probe = z.infer<typeof probeSchema>;

/** Parse the probe's output. Returns the issues instead of throwing: a bad probe is data. */
export function parseProbe(
  output: string,
): { kind: "parsed"; probe: Probe } | { kind: "invalid"; error: string } {
  const values: Record<string, string> = {};

  for (const line of output.split("\n")) {
    const at = line.indexOf("=");

    if (at <= 0) continue;
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }

  const parsed = probeSchema.safeParse(values);

  return parsed.success
    ? { kind: "parsed", probe: parsed.data }
    : {
        kind: "invalid",
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      };
}

/** Root, or root through passwordless sudo: what a rootful daemon needs. */
export const canBeRoot = (probe: Probe) => probe.sudo !== "no";

/** Facts that make each daemon method worth trying, so a skipped rung says why. */
export function rootlessPrerequisites(probe: Probe): string | null {
  if (probe.uid === "0") return "running as root; rootless is for non-root users";

  if (probe.userns !== "yes") return "unprivileged user namespaces refused (unshare -Ur)";

  if (probe.newuidmap !== "yes") return "no newuidmap (uidmap package)";

  if (probe.subuid !== "yes") return "no /etc/subuid range for the user";

  return null;
}

/** systemd-detect-virt's container answers (the rest name a hypervisor). */
const containerVirt: ReadonlySet<string> = new Set([
  "docker",
  "podman",
  "lxc",
  "lxc-libvirt",
  "systemd-nspawn",
  "openvz",
  "rkt",
  "wsl",
  "proot",
  "pouch",
  "container-other",
]);

/** How the sandbox runs, from the probe: a summary for the capability table. */
export function isolation(probe: Probe): string {
  if (probe.gvisor === "yes") return "gVisor";

  if (probe.containerMarker !== "none") return `container (${probe.containerMarker})`;

  if (containerVirt.has(probe.virt)) return `container (${probe.virt})`;

  if (probe.virt !== "unknown" && probe.virt !== "none") return `VM (${probe.virt})`;

  if (probe.hypervisorFlag === "yes") return "VM (hypervisor flag)";

  return "unknown";
}

/**
 * Nested virtualization evidence inside the guest, as observed: a /dev/kvm the sandbox user can
 * open read-write, one it cannot, or only the CPU flag. No KVM ioctl is made, so even
 * `kvm-device-rw` is not proof a VM can start.
 */
export function nestedVirt(
  probe: Probe,
): "kvm-device-rw" | "kvm-device-present" | "cpu-flag-only" | "none" {
  if (probe.kvmDevice === "rw") return "kvm-device-rw";

  if (probe.kvmDevice === "present") return "kvm-device-present";

  return probe.vmxSvm === "yes" ? "cpu-flag-only" : "none";
}

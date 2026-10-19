import { z } from "zod";
export const fingerprintSchema = z.object({
  cpuModel: z.string(),
  flags: z.array(z.string()),
  nproc: z.number().positive(),
  cpuMax: z.string(),
  quotaCpus: z.number().positive().nullable(),
  memoryMax: z.string(),
  memTotalBytes: z.number(),
  memoryBytes: z.number(),
  diskBytes: z.number(),
  df: z.string(),
  lsblk: z.string(),
  virtualization: z.string(),
  hypervisor: z.boolean(),
  dmi: z.string(),
  kernel: z.string(),
  distro: z.string(),
  user: z.string(),
  uid: z.number(),
  sudo: z.boolean(),
  stealPercent: z.number().nullable(),
  egress: z.record(z.string(), z.unknown()).nullable(),
  tools: z.record(z.string(), z.string()),
  runtime: z.string(),
});
export type Fingerprint = z.infer<typeof fingerprintSchema>;
export function parseFingerprint(text: string) {
  return fingerprintSchema.parse(JSON.parse(text));
}
export function resources(fp: Fingerprint) {
  return {
    cpu: Math.min(fp.nproc, fp.quotaCpus ?? fp.nproc),
    memoryGiB: fp.memoryBytes / 1024 ** 3,
    diskGiB: fp.diskBytes / 1024 ** 3,
  };
}

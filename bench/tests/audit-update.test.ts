import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AUDIT_SCHEMA, auditFileSchema, type AuditEntry } from "../src/cost/audit-file.js";
import { updateAuditFile } from "../src/cost/audit-update.js";

const entry = (provider: string): AuditEntry => ({
  kind: "not-reconciled",
  provider,
  profile: null,
  track: null,
  reason: `${provider} has no billing data`,
  source: null,
  blocked: null,
  checkedAt: "2026-11-16",
});

async function auditFile(entries: AuditEntry[]) {
  const path = join(await mkdtemp(join(tmpdir(), "audit-")), "audit.json");
  await writeFile(path, JSON.stringify({ schema: AUDIT_SCHEMA, entries }, null, 2) + "\n");

  return path;
}

const read = async (path: string) =>
  auditFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).entries.map((e) => e.provider);

it("keeps another writer's change made while this update was merging", async () => {
  const path = await auditFile([entry("boat")]);
  let merges = 0;

  await updateAuditFile(path, (current) => {
    merges++;

    // The first time, another agent adds boxd between our read and our rename, without the lock.
    if (merges === 1)
      writeFileSync(
        path,
        JSON.stringify({ schema: AUDIT_SCHEMA, entries: [entry("boat"), entry("boxd")] }),
      );

    return { ...current, entries: [...current.entries, entry("vercel")] };
  });

  expect(merges).toBe(2);
  expect(await read(path)).toEqual(["boat", "boxd", "vercel"]);
});

it("waits for another writer's lock, then merges on top of its result", async () => {
  const path = await auditFile([entry("boat")]);
  await mkdir(`${path}.lock`);

  const ours = updateAuditFile(path, (current) => ({
    ...current,
    entries: [...current.entries, entry("vercel")],
  }));

  await writeFile(
    path,
    JSON.stringify({ schema: AUDIT_SCHEMA, entries: [entry("boat"), entry("boxd")] }),
  );
  await rmdir(`${path}.lock`);
  await ours;

  expect(await read(path)).toEqual(["boat", "boxd", "vercel"]);
});

it("refuses a result that is not a valid audit file and leaves the file as it was", async () => {
  const path = await auditFile([entry("boat")]);
  const before = await readFile(path, "utf8");

  await expect(
    updateAuditFile(path, (current) => ({
      ...current,
      entries: [...current.entries, entry("boat")],
    })),
  ).rejects.toThrow("two entries for boat");
  expect(await readFile(path, "utf8")).toBe(before);
});

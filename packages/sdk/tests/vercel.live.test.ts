import { describe, expect, test } from "vitest";
import { Snapshot } from "@vercel/sandbox";
import { connectSandbox, createSandbox } from "../src/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import { runConformance } from "../src/testing.js";
const credentials = Boolean(process.env.VERCEL_OIDC_TOKEN || (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID));
describe.skipIf(!credentials)("Vercel live", { timeout: 120000 }, () => {
  runConformance(() => vercel(), { live: true, ports: [3000] });
});

describe.skipIf(!credentials)("Vercel live options", { timeout: 180000 }, () => {
  const day = 86_400_000;
  test("non-persistent sandbox with a lifetime and a legacy runtime", async () => {
    const provider = vercel({ persistent: false, runtime: "node22" });
    const box = await createSandbox(provider, { timeoutMs: 120_000, labels: { live: "options" } });
    try {
      expect(box.native).toMatchObject({ persistent: false, timeout: 120_000, runtime: "node22" });
      expect(box.native.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
      expect((await box.run("head -1 /etc/os-release")).stdout).toContain("Amazon Linux");
      expect([...provider.capabilities]).not.toContain("pause");
    } finally { await box.destroy(); }
  });

  test("pinned image, file modes and snapshot expiration", async () => {
    const box = await createSandbox(vercel({ image: "vercel/sandbox/node:24" }), { timeoutMs: 120_000 });
    try {
      expect(box.native.image).toMatch(/^vercel\/sandbox\/node@sha256:/);
      await box.files.write("cold.env", "A=1\n", { mode: 0o600 });
      await box.files.write("warm/secret.env", "B=2\n", { mode: 0o600 });
      await box.files.write("warm/secret.env", "B=3\n", { mode: 0o640 });
      await box.files.write("warm/tool", "#!/bin/sh\n", { mode: 0o4755 });
      expect((await box.run("stat -c %a cold.env warm/secret.env warm/tool; cat warm/secret.env")).stdout).toBe("600\n640\n4755\nB=3\n");
      const { id } = await box.snapshot({ expiresInMs: day });
      const snapshot = await Snapshot.get({ snapshotId: id });
      try {
        const expiresAt = snapshot.expiresAt?.getTime() ?? 0;
        expect(Math.abs(expiresAt - (Date.now() + day))).toBeLessThan(10 * 60_000);
      } finally { await snapshot.delete(); }
      expect((await Snapshot.get({ snapshotId: id })).status).toBe("deleted");
    } finally { await box.destroy(); }
  });

  test("connectSandbox can destroy a stopped sandbox", async () => {
    const box = await createSandbox(vercel(), { timeoutMs: 120_000 });
    try {
      await box.pause();
      const attached = await connectSandbox(vercel(), box.id);
      await attached.destroy();
      await expect(vercel().connect(box.id)).rejects.toMatchObject({ code: "not_found" });
    } finally { await box.destroy().catch(() => {}); }
  });

  test.each(["snapshot", "stop"])("a non-persistent sandbox ended by %s reports stopped and can be destroyed", async end => {
    const box = await createSandbox(vercel({ persistent: false }), { timeoutMs: 120_000 });
    try {
      if (end === "stop") await box.native.stop();
      else { const { id } = await box.snapshot(); await (await Snapshot.get({ snapshotId: id })).delete(); }
      const provider = vercel({ persistent: false });
      expect((await provider.connect(box.id)).state).toBe("stopped");
      await expect(box.run("true")).rejects.toMatchObject({ code: "not_found", provider: "vercel" });
      await provider.destroy(box.id);
      await expect(provider.connect(box.id)).rejects.toMatchObject({ code: "not_found" });
    } finally { await box.destroy().catch(() => {}); }
  });
});

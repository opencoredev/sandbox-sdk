import { it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeOwnership } from "../src/ownership.js";
vi.mock("node:fs/promises", async original => ({...await original<typeof import("node:fs/promises")>(), rename: vi.fn((await original<typeof import("node:fs/promises")>()).rename)}));
it("retains the previous complete journal if replacement is interrupted", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "ownership-"));
  const path = join(directory, "ownership.json");
  try {
    await writeOwnership(path, '{"resources":["old"]}');
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("interrupted before rename"));
    await expect(writeOwnership(path, '{"resources":["new"]}')).rejects.toThrow("interrupted");
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({resources: ["old"]});
    expect(await fs.readdir(directory)).toEqual(["ownership.json"]);
    await writeOwnership(path, '{"resources":["new"]}');
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({resources: ["new"]});
  } finally { vi.restoreAllMocks(); await fs.rm(directory, {recursive: true, force: true}); }
});

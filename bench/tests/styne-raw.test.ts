/**
 * The raw Styne floor in `scripts/sdk-overhead.ts`: the key goes only to an https (or loopback) API and
 * never follows a redirect, and a create is used and cleaned up only once a read of the sandbox it names
 * carries that create's own owner marker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { rawOwnerLabel } from "../src/maritime-raw.js";
import { createRawStyne, styneCall, type RawStyneBox } from "../src/styne-raw.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Answer every fetch from `respond`, recording each request and its redirect mode. */
function stubFetch(respond: (method: string, url: URL, body: string) => [number, unknown]) {
  const seen: string[] = [];

  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    seen.push(`${method} ${url.pathname} ${init?.redirect ?? "follow"}`);
    const [status, body] = respond(method, url, z.string().catch("").parse(init?.body));

    return Response.json(body, { status });
  });

  return seen;
}

describe("raw Styne calls", () => {
  it("refuse a plaintext API URL off loopback before the key is sent", async () => {
    vi.stubEnv("STYNE_API_URL", "http://api.styne.example");
    const seen = stubFetch(() => [200, []]);

    await expect(styneCall("/sandboxes")).rejects.toThrow(/https/);
    expect(seen).toEqual([]);
  });

  it("never follow a redirect", async () => {
    vi.stubEnv("STYNE_API_URL", "https://api.styne.invalid");
    const seen = stubFetch(() => [200, []]);

    await styneCall("/sandboxes");
    expect(seen).toEqual(["GET /sandboxes error"]);
  });

  it("admit a created sandbox only when it carries this create's owner marker", async () => {
    vi.stubEnv("STYNE_API_URL", "https://api.styne.invalid");
    let owner = "";

    stubFetch((method, url, body) => {
      if (method === "POST") {
        owner = JSON.parse(body).metadata[rawOwnerLabel];

        return [201, { sandboxID: "vmOperator" }];
      }

      if (url.pathname === "/sandboxes/vmOperator")
        return [200, { sandboxID: "vmOperator", metadata: { [rawOwnerLabel]: "someone-else" } }];

      // The listing by this create's marker finds the sandbox it really made.
      return [200, [{ sandboxID: "vmMine", metadata: { [rawOwnerLabel]: owner } }]];
    });

    const admitted: RawStyneBox[] = [];

    await expect(
      createRawStyne({ template: "base", labels: {}, admit: (box) => admitted.push(box) }),
    ).rejects.toThrow(/did not make/);
    expect(owner).not.toBe("");
    expect(admitted.map((box) => box.id)).toEqual(["vmMine"]);
  });

  it("admit the sandbox a create made once its read carries the marker", async () => {
    vi.stubEnv("STYNE_API_URL", "https://api.styne.invalid");
    let owner = "";

    stubFetch((method, _url, body) => {
      if (method === "POST") {
        owner = JSON.parse(body).metadata[rawOwnerLabel];

        return [201, { sandboxID: "vmMine" }];
      }

      return [200, { sandboxID: "vmMine", metadata: { [rawOwnerLabel]: owner } }];
    });

    const admitted: RawStyneBox[] = [];

    const box = await createRawStyne({
      template: "base",
      labels: {},
      admit: (b) => admitted.push(b),
    });

    expect(box.id).toBe("vmMine");
    expect(admitted).toEqual([box]);
  });
});

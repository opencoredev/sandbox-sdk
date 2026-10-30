import { describe, expect, test } from "vitest";
import { SandboxError } from "../src/index.js";
import { boundaryOf, firstPart, readAll } from "../src/providers/daytona/multipart.js";
import { chunked, pieces } from "./http-fake.js";

const options = { provider: "daytona", sandboxId: "sb-1" };
const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
/** Daytona's real bulk-download framing, as captured from the live daemon. */
function body(part: Uint8Array, headers = "Content-Type: application/octet-stream", name = "file") {
  const head = new TextEncoder().encode(`--DAYTONA-FILE-BOUNDARY\r\nContent-Disposition: form-data; name="${name}"; filename="/tmp/a.bin"; filename*=utf-8''%2Ftmp%2Fa.bin\r\n${headers}\r\n\r\n`);
  const tail = new TextEncoder().encode("\r\n--DAYTONA-FILE-BOUNDARY--\r\n");
  const out = new Uint8Array(head.length + part.length + tail.length);
  out.set(head); out.set(part, head.length); out.set(tail, head.length + part.length);
  return out;
}
async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(SandboxError); return error as SandboxError; }
  throw new Error("expected a rejection");
}

describe("boundaryOf", () => {
  test("reads plain and quoted boundaries and rejects other types", () => {
    expect(boundaryOf("multipart/form-data; boundary=DAYTONA-FILE-BOUNDARY")).toBe("DAYTONA-FILE-BOUNDARY");
    expect(boundaryOf('multipart/form-data; charset=utf-8; boundary="a b:c"')).toBe("a b:c");
    expect(boundaryOf("application/json")).toBeUndefined();
    expect(boundaryOf("multipart/form-data")).toBeUndefined();
    expect(boundaryOf(null)).toBeUndefined();
  });
});

describe("firstPart", () => {
  test("every chunk size, including splits inside the delimiter, the headers and CRLFs, yields the exact bytes", async () => {
    // The part body holds bytes that look like a delimiter: CR, LF and dashes, and the whole delimiter
    // followed by something other than "--" or CRLF, which is data because Daytona's boundary is fixed.
    const tricky = new Uint8Array([...bytes, 13, 10, 45, 45, 68, 65, 13, 10, 45, ...new TextEncoder().encode("\r\n--DAYTONA-FILE-BOUNDARYxx\r\n--DAYTONA-FILE-BOUNDARY-"), ...bytes]);
    const whole = body(tricky, `Content-Length: ${tricky.length}\r\nContent-Type: text/plain; charset=utf-8`);
    for (let size = 1; size <= 80; size++) {
      const part = await firstPart(chunked(pieces(whole, size)), "DAYTONA-FILE-BOUNDARY", options);
      expect(part).toMatchObject({ name: "file", filename: "/tmp/a.bin", headers: { "content-length": String(tricky.length) } });
      expect(await readAll(part.body)).toEqual(tricky);
    }
  });

  test("streams the part before the body ends", async () => {
    const whole = body(new Uint8Array(100_000).fill(7));
    const source = chunked(pieces(whole, 4096));
    const part = await firstPart(source, "DAYTONA-FILE-BOUNDARY", options);
    const reader = part.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.length).toBeGreaterThan(0);
    await reader.cancel();
    expect(source.cancelled()).toBe(true);
  });

  test("an empty part and a preamble are fine", async () => {
    const part = await firstPart(chunked(["preamble\r\n", body(new Uint8Array())]), "DAYTONA-FILE-BOUNDARY", options);
    expect(await readAll(part.body)).toEqual(new Uint8Array());
  });

  test("an error part comes back with its name and JSON body", async () => {
    const json = JSON.stringify({ statusCode: 404, message: "file not found: /tmp/a.bin", code: "FILE_NOT_FOUND" });
    const part = await firstPart(chunked(pieces(body(new TextEncoder().encode(json), "Content-Type: application/json; charset=utf-8", "error"), 7)), "DAYTONA-FILE-BOUNDARY", options);
    expect(part.name).toBe("error");
    expect(new TextDecoder().decode(await readAll(part.body))).toBe(json);
  });

  test("a body that ends inside the part, or before its delimiter, is truncated (unavailable, retryable)", async () => {
    const whole = body(bytes);
    for (const cut of [whole.length - 3, whole.length - 30, whole.length - 200]) {
      const part = await firstPart(chunked(pieces(whole.subarray(0, cut), 16)), "DAYTONA-FILE-BOUNDARY", options);
      expect(await failure(readAll(part.body))).toMatchObject({ code: "unavailable", retryable: true, sandboxId: "sb-1" });
    }
    for (const cut of [10, 40]) expect(await failure(firstPart(chunked([whole.subarray(0, cut)]), "DAYTONA-FILE-BOUNDARY", options))).toMatchObject({ code: "unavailable" });
  });

  test("a dropped connection mid-part rejects the part's stream", async () => {
    const part = await firstPart(chunked([body(bytes).subarray(0, 200)], { error: new Error("socket hang up") }), "DAYTONA-FILE-BOUNDARY", options);
    await expect(readAll(part.body)).rejects.toThrow();
  });

  test("a Content-Length that disagrees with the delimiter is malformed", async () => {
    for (const declared of [bytes.length - 1, bytes.length + 1]) {
      const part = await firstPart(chunked([body(bytes, `Content-Length: ${declared}`)]), "DAYTONA-FILE-BOUNDARY", options);
      expect(await failure(readAll(part.body))).toMatchObject({ code: "provider" });
    }
  });

  test("no parts, a wrong boundary or oversized headers are malformed", async () => {
    expect(await failure(firstPart(chunked(["--DAYTONA-FILE-BOUNDARY--\r\n"]), "DAYTONA-FILE-BOUNDARY", options))).toMatchObject({ code: "provider" });
    expect(await failure(firstPart(chunked(["x".repeat(20_000)]), "DAYTONA-FILE-BOUNDARY", options))).toMatchObject({ code: "provider" });
    expect(await failure(firstPart(chunked([`--DAYTONA-FILE-BOUNDARY\r\nX: ${"y".repeat(20_000)}`]), "DAYTONA-FILE-BOUNDARY", options))).toMatchObject({ code: "provider" });
  });
});

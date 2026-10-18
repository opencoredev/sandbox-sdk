import { describe, test, expect } from "vitest";
import { local } from "../src/providers/local/index.js";
import { Demux } from "../src/providers/local/docker.js";

describe("local transport", () => {
  test("rejects remote Docker hosts that cannot supply localhost previews", () => {
    expect(() => local({ dockerHost: "tcp://example.com:2375" })).toThrowError(expect.objectContaining({ code: "unsupported" }));
  });
  test("declares only implemented capabilities", () => {
    const provider = local();
    expect(provider.keyMode).toBe("exact");
    expect([...provider.capabilities].sort()).toEqual(["network-policy", "pause", "size", "snapshot"]);
    expect(provider.terminal).toBeUndefined();
  });
  test("demultiplexes split headers and split UTF-8 without corrupting bytes", () => {
    const output: string[] = []; const demux = new Demux(chunk => output.push(`${chunk.stream}:${chunk.text}`));
    const frame = (stream: number, bytes: Buffer) => { const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(bytes.length, 4); return Buffer.concat([header, bytes]); };
    const bytes = Buffer.from("€");
    const wire = Buffer.concat([frame(1, bytes.subarray(0, 1)), frame(2, Buffer.from("error")), frame(1, bytes.subarray(1))]);
    for (const byte of wire) demux.push(Buffer.from([byte]));
    demux.end(); expect(output).toEqual(["stderr:error", "stdout:€"]);
  });
  test("rejects truncated output rather than silently losing bytes", () => {
    const demux = new Demux(() => {}); demux.push(Buffer.from([1])); expect(() => demux.end()).toThrow();
  });
  test("fails closed before creating resources", async () => {
    const provider = local({ dockerHost: "unix:///nonexistent-sbx25.sock" });
    for (const options of [{ labels: {}, network: { allow: ["example.com"] } }, { labels: {}, timeoutMs: 1000 }, { labels: {}, idleTimeoutMs: 1000 }, { labels: {}, size: { cpu: 1, memoryMb: 1024, diskGb: 1 } }] satisfies import("../src/provider.js").CreateInput[]) {
      await expect(provider.create({ ...options, labels: {} })).rejects.toMatchObject({ code: "unsupported" });
    }
  });
});

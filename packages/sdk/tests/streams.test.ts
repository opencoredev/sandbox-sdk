import { describe, expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import {
  connectEnvelope,
  connectEnvelopes,
  ndjson,
  sse,
  streamFault,
  type StreamOptions,
} from "../src/streams.js";
import { chunked, pieces } from "./http-fake.js";

const options: StreamOptions = { provider: "fake", sandboxId: "sb" };

async function collect<T>(
  frames: AsyncIterable<T>,
): Promise<{ frames: T[]; error?: SandboxError }> {
  const out: T[] = [];

  try {
    for await (const frame of frames) out.push(frame);
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);

    return { frames: out, error: error as SandboxError };
  }

  return { frames: out };
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }

  return out;
};

describe("ndjson", () => {
  const text = '{"out":"héllo 🌍"}\r\n\n{"out":"ok"}\n{"exit":0}\n';
  test.each([1, 2, 3, 5, 7])("splits lines and UTF-8 across %i-byte chunks", async (size) => {
    const { frames, error } = await collect(ndjson(chunked(pieces(text, size)), options));
    expect(error).toBeUndefined();
    expect(frames).toEqual([{ out: "héllo 🌍" }, { out: "ok" }, { exit: 0 }]);
  });

  test("a last line without a newline is accepted when it is complete JSON", async () => {
    expect((await collect(ndjson(chunked(['{"a":1}\n{"b":2}']), options))).frames).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  test("a body that ends inside a line is truncated", async () => {
    const { frames, error } = await collect(ndjson(chunked(['{"a":1}\n{"b":']), options));
    expect(frames).toEqual([{ a: 1 }]);
    expect(streamFault(error)).toBe("truncated");
    expect(error).toMatchObject({
      code: "unavailable",
      retryable: true,
      provider: "fake",
      sandboxId: "sb",
    });
  });

  test("an invalid line is malformed and cancels the body", async () => {
    const body = chunked(["nope\n", '{"a":1}\n']);
    const { error } = await collect(ndjson(body, options));
    expect(streamFault(error)).toBe("malformed");
    expect(body.cancelled()).toBe(true);
  });

  test("a line over maxFrameBytes is frame_too_large, even before its newline arrives", async () => {
    const body = chunked(["x".repeat(40), "x".repeat(40), "\n"]);
    const { error } = await collect(ndjson(body, { ...options, maxFrameBytes: 64 }));
    expect(streamFault(error)).toBe("frame_too_large");
    expect(body.cancelled()).toBe(true);
  });

  test("a read error mid-stream is disconnected", async () => {
    const { frames, error } = await collect(
      ndjson(chunked(['{"a":1}\n'], { error: new TypeError("terminated") }), options),
    );

    expect(frames).toEqual([{ a: 1 }]);
    expect(streamFault(error)).toBe("disconnected");
    expect(String(error?.cause)).toContain("terminated");
  });

  test("leaving the loop early cancels the body", async () => {
    const body = chunked(['{"a":1}\n', '{"a":2}\n', '{"a":3}\n']);

    for await (const frame of ndjson(body, options)) {
      expect(frame).toEqual({ a: 1 });
      break;
    }

    expect(body.cancelled()).toBe(true);
  });

  test("the signal aborts and cancels", async () => {
    const controller = new AbortController();
    const body = chunked(['{"a":1}\n', '{"a":2}\n']);
    const seen: unknown[] = [];
    let caught: unknown;

    try {
      for await (const frame of ndjson(body, { ...options, signal: controller.signal })) {
        seen.push(frame);
        controller.abort();
      }
    } catch (error) {
      caught = error;
    }

    expect(seen).toHaveLength(1);
    expect((caught as SandboxError).code).toBe("aborted");
    expect(body.cancelled()).toBe(true);
  });
});

describe("sse", () => {
  const stream =
    '﻿: comment\nevent: stdout\ndata: line 1\ndata: line 2 é\nid: 7\n\nretry: 1500\ndata:{"x":1}\r\n\r\nevent: only-name\n\ndata: after\rid: 8\r\r';

  test.each([1, 2, 3, 4, 9])(
    "parses fields, CR, LF and CRLF across %i-byte chunks",
    async (size) => {
      const { frames, error } = await collect(sse(chunked(pieces(stream, size)), options));
      expect(error).toBeUndefined();
      expect(frames).toEqual([
        { event: "stdout", data: "line 1\nline 2 é", id: "7" },
        { event: "message", data: '{"x":1}', id: "7", retry: 1500 },
        { event: "message", data: "after", id: "8" },
      ]);
    },
  );

  test("a CRLF split between chunks is one line end", async () => {
    const { frames } = await collect(sse(chunked(["data: a\r", "\n\r", "\ndata: b\n\n"]), options));
    expect(frames.map((frame) => frame.data)).toEqual(["a", "b"]);
  });

  test("a body that ends inside an event is truncated", async () => {
    const { frames, error } = await collect(sse(chunked(["data: a\n\ndata: b\n"]), options));
    expect(frames.map((frame) => frame.data)).toEqual(["a"]);
    expect(streamFault(error)).toBe("truncated");
  });

  test("lenientEnd dispatches the last event instead", async () => {
    const { frames, error } = await collect(
      sse(chunked(["data: a\n\ndata: b"]), { ...options, lenientEnd: true }),
    );

    expect(error).toBeUndefined();
    expect(frames.map((frame) => frame.data)).toEqual(["a", "b"]);
  });

  test("an event over maxFrameBytes is frame_too_large", async () => {
    const { error } = await collect(
      sse(chunked(["data: aaaaaaaaaa\n".repeat(10), "\n"]), { ...options, maxFrameBytes: 64 }),
    );

    expect(streamFault(error)).toBe("frame_too_large");
  });

  test("the event limit counts UTF-8 bytes and separators, not characters", async () => {
    // Four lines of three "é" (6 bytes each) join to 4 × 6 + 3 = 27 bytes, but only 15 characters.
    const event = "data: ééé\n".repeat(4) + "\n";
    expect(
      streamFault((await collect(sse(chunked([event]), { ...options, maxFrameBytes: 26 }))).error),
    ).toBe("frame_too_large");
    expect(
      (await collect(sse(chunked([event]), { ...options, maxFrameBytes: 27 }))).frames.map(
        (frame) => frame.data,
      ),
    ).toEqual(["ééé\nééé\nééé\nééé"]);
    // A 4-byte character is two UTF-16 units: three lines join to 3 × 4 + 2 = 14 bytes, not 6 units.
    const emoji = "data:😀\n".repeat(3) + "\n";
    expect(
      streamFault((await collect(sse(chunked([emoji]), { ...options, maxFrameBytes: 13 }))).error),
    ).toBe("frame_too_large");
    expect(
      (await collect(sse(chunked([emoji]), { ...options, maxFrameBytes: 14 }))).frames,
    ).toHaveLength(1);
  });
});

describe("connect envelopes", () => {
  // Process output as E2B's envd sends it: base64 bytes fields inside JSON messages.
  const messages = [
    { event: { data: { stdout: Buffer.from("héllo\n").toString("base64") } } },
    { event: { end: { exitCode: 0 } } },
  ];

  const body = concat(
    ...messages.map((message) => connectEnvelope(message)),
    connectEnvelope({ metadata: { "x-trace": ["t1"] } }, true),
  );

  test.each([1, 2, 4, 5, 6, 13])("reassembles frames from %i-byte chunks", async (size) => {
    const { frames, error } = await collect(connectEnvelopes(chunked(pieces(body, size)), options));
    expect(error).toBeUndefined();
    expect(frames).toEqual([
      ...messages.map((message) => ({ kind: "message", message })),
      { kind: "end", metadata: { "x-trace": ["t1"] } },
    ]);
    const first = frames[0];
    const data = first?.kind === "message" ? JSON.stringify(first.message) : "";
    expect(Buffer.from(JSON.parse(data).event.data.stdout, "base64").toString()).toBe("héllo\n");
  });

  test("the end frame carries the terminal error", async () => {
    const { frames } = await collect(
      connectEnvelopes(
        chunked([
          connectEnvelope({ error: { code: "deadline_exceeded", message: "too slow" } }, true),
        ]),
        options,
      ),
    );

    expect(frames).toEqual([
      { kind: "end", error: { code: "deadline_exceeded", message: "too slow" } },
    ]);
  });

  test("a body without the end frame is truncated", async () => {
    const { frames, error } = await collect(
      connectEnvelopes(chunked([connectEnvelope({ a: 1 })]), options),
    );

    expect(frames).toHaveLength(1);
    expect(streamFault(error)).toBe("truncated");
  });

  test.each([
    ["a partial header", 3],
    ["a partial payload", 9],
  ] as const)("a body that ends inside %s is truncated", async (_label, cut) => {
    const { error } = await collect(
      connectEnvelopes(chunked([connectEnvelope({ a: 1 }).subarray(0, cut)]), options),
    );

    expect(streamFault(error)).toBe("truncated");
  });

  test("a frame after the end frame, a compressed frame and unknown flags are malformed", async () => {
    const after = concat(connectEnvelope({}, true), connectEnvelope({ a: 1 }));
    expect(streamFault((await collect(connectEnvelopes(chunked([after]), options))).error)).toBe(
      "malformed",
    );
    const compressed = connectEnvelope({ a: 1 });
    compressed[0] = 0x01;
    expect(
      streamFault((await collect(connectEnvelopes(chunked([compressed]), options))).error),
    ).toBe("malformed");
    const flagged = connectEnvelope({ a: 1 });
    flagged[0] = 0x80;
    expect(streamFault((await collect(connectEnvelopes(chunked([flagged]), options))).error)).toBe(
      "malformed",
    );
  });

  test("a frame over maxFrameBytes is rejected from its header, before the payload arrives", async () => {
    const header = new Uint8Array([0, 0x7f, 0xff, 0xff, 0xff]);
    const source = chunked([header]);
    expect(streamFault((await collect(connectEnvelopes(source, options))).error)).toBe(
      "frame_too_large",
    );
    expect(source.cancelled()).toBe(true);
  });

  test("leaving early cancels the body", async () => {
    const source = chunked(pieces(body, 4));

    for await (const frame of connectEnvelopes(source, options)) {
      expect(frame.kind).toBe("message");
      break;
    }

    expect(source.cancelled()).toBe(true);
  });
});

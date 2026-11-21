import { describe, expect, test } from "vitest";
import { decodeNative } from "../src/shared/native-error.js";

describe("decodeNative reads gRPC metadata in every client shape", () => {
  const expected = new Map([
    ["x-request-id", "req-1"],
    ["grpc-status-details", "a,b"],
  ]);

  test("a fetch Headers, as Connect clients use", () => {
    const metadata = new Headers({ "x-request-id": "req-1", "grpc-status-details": "a,b" });

    expect(decodeNative({ metadata }).metadata).toEqual(expected);
  });

  test("an iterable of [key, values], as nice-grpc's Metadata is", () => {
    const metadata = new Map<string, (string | Uint8Array)[]>([
      ["x-request-id", ["req-1"]],
      ["grpc-status-details", ["a", "b"]],
      ["trace-bin", [new Uint8Array([1])]],
    ]);

    expect(decodeNative({ metadata }).metadata).toEqual(expected);
  });

  test("an object with getMap(), as grpc-js's Metadata is", () => {
    const metadata = {
      getMap: () => ({
        "x-request-id": "req-1",
        "grpc-status-details": "a,b",
        "trace-bin": Buffer.of(1),
      }),
    };

    expect(decodeNative({ metadata }).metadata).toEqual(expected);
  });

  test("a plain object, and an accessor that throws yields no metadata instead of throwing", () => {
    expect(
      decodeNative({ metadata: { "x-request-id": "req-1", "grpc-status-details": ["a", "b"] } })
        .metadata,
    ).toEqual(expected);

    const hostile = {
      getMap() {
        throw new Error("boom");
      },
    };

    expect(decodeNative({ metadata: hostile }).metadata).toEqual(new Map());
  });
});

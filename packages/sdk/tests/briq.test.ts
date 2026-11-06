import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { nativeSandbox } from "@briq-cloud/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { createSandbox, listSandboxes } from "../src/index.js";
import type { CreateInput, ExecInput } from "../src/provider.js";
import { briq } from "../src/providers/briq/index.js";
import { createBriqProvider } from "../src/providers/briq/provider.js";
import { rejection } from "./rejection.js";

type Start = { cmd?: string[]; stdin?: string; env?: Record<string, string> };

type Wire = {
  exit_code?: number;
  cancelled?: boolean;
  timed_out?: boolean;
  code?: string;
  error?: string;
};

type Peer = { socket: WebSocket; start: Start; cancel: () => void };

type Spec = {
  name?: string;
  size?: string;
  labels?: Record<string, string>;
  env?: Record<string, { secret: string; value: string; literal: boolean }>;
};

type Row = Spec & { id: string; teamId: string; stackId: string; state: string; createdAt: string };

type Body = { spec?: Spec; port?: number; mode?: string } | null;

let server: WebSocketServer;
let baseUrl: string;
let connections = 0;
const behavior: Array<(peer: Peer) => void> = [];

const end = (socket: WebSocket, value: Wire) =>
  socket.send(Buffer.concat([Buffer.from([3]), Buffer.from(JSON.stringify(value))]));

// A guest agent on loopback: the frame protocol is 1 stdout, 2 stderr, 3 end, 5 start, 6 cancel.
beforeAll(async () => {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  // SAFETY: the server listens on a TCP port, so address() is an AddressInfo, not a pipe name.
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on("connection", (socket, request) => {
    connections++;
    expect(new URL(request.url ?? "", "http://test").search).toBe("");
    let peer: Peer | undefined;
    socket.on("message", (raw) => {
      const data =
        raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : raw;

      if (data[0] === 6) {
        peer?.cancel();

        return;
      }

      expect(data[0]).toBe(5);
      const start: Start = JSON.parse(data.subarray(1).toString());
      peer = { socket, start, cancel: () => end(socket, { exit_code: 137, cancelled: true }) };
      const next = behavior.shift();

      if (next) next(peer);
      else end(socket, { exit_code: 0 });
    });
  });
});

afterAll(async () => {
  for (const client of server.clients) client.terminate();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllEnvs();
  behavior.length = 0;
});

function fixture(
  options: {
    labelsSupported?: boolean;
    literalSupported?: boolean;
    createStatus?: number;
    availableSizes?: string[];
  } = {},
) {
  const calls: Array<{ method: string; path: string; body: Body; headers: Headers }> = [];
  const rows: Row[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body: Body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ method, path: url.pathname, body, headers: new Headers(init?.headers) });
    expect(init?.redirect).toBe("error");

    if (url.pathname === "/v1/quota")
      return Response.json({
        features: {
          briqLabels: options.labelsSupported ?? true,
          literalEnvSecrets: options.literalSupported ?? true,
        },
        availableSizes: options.availableSizes ?? ["small"],
        team: { id: "tm_owned" },
      });

    if (url.pathname === "/v1/briqs" && method === "POST") {
      if (options.createStatus)
        return Response.json(
          { error: { message: "SECRET-provider-message", code: "provider_error" } },
          { status: options.createStatus },
        );

      const row = {
        ...body?.spec,
        id: `bq_owned${rows.length}`,
        teamId: "tm_owned",
        stackId: "st_owned",
        state: "running",
        createdAt: "2026-11-02T00:00:00.000Z",
      };

      rows.push(row);

      return Response.json({ briqs: [row] }, { status: 201 });
    }

    if (url.pathname === "/v1/briqs") return Response.json({ briqs: rows });

    const row = rows.find(
      (candidate) =>
        url.pathname === `/v1/briqs/${candidate.id}` ||
        url.pathname === `/v1/briqs/${candidate.id}/expose`,
    );

    if (!row)
      return Response.json({ error: { message: "SECRET-provider-message" } }, { status: 403 });

    if (method === "DELETE") {
      row.state = "destroyed";

      return Response.json({ briq: row });
    }

    if (url.pathname.endsWith("/expose"))
      return Response.json({ url: "https://private-preview.invalid/?briq_token=private" });

    return Response.json({ briq: row });
  };

  return { provider: briq({ apiKey: "fixture-key", baseUrl, fetch: fetcher }), calls, rows };
}

const input = (extra: Partial<CreateInput> = {}): CreateInput => ({
  labels: { suite: "contract" },
  ...extra,
});

const command = (extra: Partial<ExecInput> = {}): ExecInput => ({
  command: "cat",
  cwd: "/workspace",
  env: {},
  timeoutMs: 2000,
  onChunk: () => {},
  ...extra,
});

describe("Briq provider", () => {
  it("fits the core create, key lookup, label listing and cleanup contract", async () => {
    const f = fixture();
    const first = await createSandbox(f.provider, { key: "core-key", labels: { suite: "core" } });
    const second = await createSandbox(f.provider, { key: "core-key" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(
      (await listSandboxes(f.provider, { labels: { suite: "core" } })).map((row) => row.id),
    ).toEqual([first.id]);
    await first.destroy();
    await second.destroy();
  });

  it("rejects own reserved prototype labels before transport", async () => {
    const f = fixture();
    await expect(
      f.provider.create(input({ labels: JSON.parse('{"__proto__":"owned"}') })),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(f.calls).toEqual([]);
  });

  it("reports an invalid origin on first use without echoing it", async () => {
    const failure = await rejection(
      briq({ apiKey: "fixture", baseUrl: "secret invalid origin" }).list({}),
    );

    expect(failure).toMatchObject({ code: "invalid_argument", message: "Invalid Briq API origin" });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("uses persisted labels, best-effort lookup, connect, list, destroy and a credential-free native surface", async () => {
    const f = fixture();
    const made = await f.provider.create(input({ key: "unicode 雪" }));
    expect(f.provider.keyMode).toBe("best-effort");
    expect([...f.provider.capabilities]).toEqual(["size"]);
    expect(made).toMatchObject({
      key: "unicode 雪",
      labels: { suite: "contract" },
      state: "running",
    });
    expect((await f.provider.find("unicode 雪"))?.id).toBe(made.id);
    expect(await f.provider.list({ suite: "absent" })).toEqual([]);
    expect((await f.provider.connect(made.id)).id).toBe(made.id);
    expect(await f.provider.native(made.id).status()).not.toHaveProperty("apiKey");
    expect(await f.provider.previewUrl(made.id, 3000)).toEqual({
      url: "https://private-preview.invalid/?briq_token=private",
      headers: { cookie: "briq_token=private" },
    });
    expect(f.calls.find((call) => call.path.endsWith("/expose"))?.body).toEqual({
      port: 3000,
      mode: "private",
    });
    await f.provider.destroy(made.id);
    expect(await f.provider.list({})).toEqual([]);
  });

  it("stores creation environment as literal encrypted secrets, including empty values", async () => {
    const f = fixture();
    await f.provider.create(
      input({
        env: JSON.parse(
          JSON.stringify({
            TOKEN: "private-fixture",
            EMPTY: "",
            ["__proto__"]: "{{briq:missing}} {{secret:missing}} {{self:host}}\n雪",
            "a b/雪": "literal",
          }),
        ),
      }),
    );

    const request = f.calls.find((call) => call.method === "POST" && call.path === "/v1/briqs");

    expect(request?.body).not.toHaveProperty("stack");
    expect(request?.body?.spec?.env).toEqual({
      TOKEN: {
        secret: expect.stringMatching(/^OC_[a-f0-9]{32}_0$/),
        value: "private-fixture",
        literal: true,
      },
      EMPTY: { secret: expect.stringMatching(/^OC_[a-f0-9]{32}_1$/), value: "", literal: true },
      ["__proto__"]: {
        secret: expect.stringMatching(/^OC_[a-f0-9]{32}_2$/),
        value: "{{briq:missing}} {{secret:missing}} {{self:host}}\n雪",
        literal: true,
      },
      "a b/雪": {
        secret: expect.stringMatching(/^OC_[a-f0-9]{32}_3$/),
        value: "literal",
        literal: true,
      },
    });
  });

  it("rejects unsupported options before any API call, and an API without the features it needs", async () => {
    for (const extra of [
      { network: "none" as const },
      { idleTimeoutMs: 1 },
      { timeoutMs: 1 },
      { from: "snapshot" },
    ]) {
      const f = fixture();
      await expect(f.provider.create(input(extra))).rejects.toMatchObject({ code: "unsupported" });
      expect(f.calls).toEqual([]);
    }

    const noLiteral = fixture({ literalSupported: false });
    await expect(
      noLiteral.provider.create(input({ env: { TOKEN: "{{briq:db}}" } })),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(noLiteral.calls.filter((call) => call.method === "POST")).toEqual([]);

    const old = fixture({ labelsSupported: false });
    await expect(old.provider.create(input())).rejects.toMatchObject({ code: "unsupported" });
    expect(old.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("maps the core's named sizes to the Briq sizes, and none to the default", async () => {
    const f = fixture({ availableSizes: ["small", "medium", "large", "xlarge"] });

    for (const size of ["small", "medium", "large"] as const) {
      const made = await f.provider.create(input({ size }));
      expect(f.rows.find((row) => row.id === made.id)?.size).toBe(size);
    }

    const plain = await f.provider.create(input());
    expect(f.rows.find((row) => row.id === plain.id)?.size).toBe("small");
  });

  it("refuses any other size before any API call", async () => {
    for (const size of [
      { cpu: 2, memoryMb: 4096 },
      { cpu: 1, memoryMb: 1024, diskGb: 10 },
      "xs",
      "xl",
      "xlarge",
      "2xl",
      "toString",
      "",
      null,
      7,
    ]) {
      const f = fixture({ availableSizes: ["small", "medium", "large", "xlarge"] });
      // JS callers can pass values outside CreateInput["size"]; Object.assign keeps the type loose.
      const extra: Partial<CreateInput> = Object.assign<Partial<CreateInput>, object>({}, { size });
      await expect(f.provider.create(input(extra))).rejects.toMatchObject({ code: "unsupported" });
      expect(f.calls).toEqual([]);
    }
  });

  it("reports a size the plan does not offer as unsupported without creating", async () => {
    const f = fixture({ availableSizes: ["small"] });
    await expect(f.provider.create(input({ size: "large" }))).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(f.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("rejects a custom image option", () => {
    const options = Object.assign({ apiKey: "fixture" }, { image: "alpine" });
    expect(() => briq(options)).toThrowError("Custom sandbox images are unsupported");
  });

  it("does not retry a potentially applied create and omits native error text", async () => {
    const f = fixture({ createStatus: 503 });
    await expect(f.provider.create(input())).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);

    const failure = await rejection(f.provider.connect("foreign"));
    expect(JSON.stringify(failure)).not.toContain("SECRET");
    expect(failure).toMatchObject({ code: "auth", provider: "briq" });
  });

  it("cleans up an owned create when the running guest refuses streaming", async () => {
    const f = fixture();
    behavior.push(({ socket }) =>
      end(socket, { code: "unsupported", error: "SECRET-init-detail" }),
    );
    await expect(f.provider.create(input())).rejects.toMatchObject({ code: "unsupported" });
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("preserves cross-stream arrival order and finite stdin", async () => {
    const f = fixture();
    const made = await f.provider.create(input());
    const chunks: string[] = [];
    behavior.push(({ socket, start }) => {
      expect(start.cmd).toEqual(["sh", "-c", "cat"]);
      expect(start.stdin).toBe("finite\n");
      expect(start.env).toEqual({ TOKEN: "not-in-url" });

      for (const frame of [Buffer.from([1, 65]), Buffer.from([2, 66]), Buffer.from([1, 67])])
        socket.send(frame);
      end(socket, { exit_code: 0 });
    });
    expect(
      await f.provider.exec(
        made.id,
        command({
          stdin: "finite\n",
          env: { TOKEN: "not-in-url" },
          onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
        }),
      ),
    ).toEqual({ exitCode: 0, timedOut: false });
    expect(chunks).toEqual(["stdout:A", "stderr:B", "stdout:C"]);

    behavior.push(({ socket, start }) => {
      expect(start.stdin).toBe("");
      end(socket, { exit_code: 0 });
    });
    await f.provider.exec(made.id, command());
  });

  it("waits for the cancellation acknowledgement and refuses cleanup ambiguity", async () => {
    const f = fixture();
    const made = await f.provider.create(input());
    const abort = new AbortController();
    let acknowledged = () => {};
    let cancelSeen = () => {};

    const cancelled = new Promise<void>((resolve) => {
      cancelSeen = resolve;
    });

    behavior.push((peer) => {
      peer.cancel = () => {
        cancelSeen();
        acknowledged = () => end(peer.socket, { exit_code: 137, cancelled: true });
      };

      peer.socket.send(Buffer.concat([Buffer.from([1]), Buffer.from("CHILD\n")]));
    });
    let settled = false;

    const result = f.provider
      .exec(made.id, command({ signal: abort.signal, onChunk: () => abort.abort() }))
      .finally(() => {
        settled = true;
      });

    await cancelled;
    expect(settled).toBe(false);
    acknowledged();
    expect(await result).toEqual({ exitCode: null, timedOut: true });

    behavior.push(({ socket }) => end(socket, { code: "exec_cleanup_failed", error: "SECRET" }));
    await expect(f.provider.exec(made.id, command())).rejects.toMatchObject({
      code: "outcome_unknown",
    });
  });

  it("maps native timeouts but never returns a fake exit or retries after socket loss", async () => {
    const f = fixture();
    const made = await f.provider.create(input());
    behavior.push(({ socket }) => end(socket, { exit_code: 137, timed_out: true }));
    expect(await f.provider.exec(made.id, command())).toEqual({ exitCode: null, timedOut: true });

    const before = connections;
    behavior.push(({ socket }) => socket.terminate());
    await expect(f.provider.exec(made.id, command())).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(connections - before).toBe(1);
  });

  it("keeps the preview credential when the core applies a path", async () => {
    const f = fixture();
    const box = await createSandbox(f.provider);
    const preview = await box.preview(3000, { path: "/health?x=1" });

    expect(preview.url).toBe("https://private-preview.invalid/health?x=1");
    expect(preview.headers).toEqual({ cookie: "briq_token=private" });
    expect((await box.preview(3000)).url).toContain("briq_token=private");
  });

  it("keeps a guest search over 32 KiB off stdin, where Briq's limit is 512 KiB", async () => {
    const f = fixture();
    const box = await createSandbox(f.provider);
    expect(await f.provider.files.guestInput?.(box.id)).toBe("env");

    const exec = vi.spyOn(f.provider, "exec");
    const sent = () => exec.mock.calls.map(([, call]) => call);
    // The fixture serves no file RPC, so the search itself fails; what it ran is what counts.
    await box.files.search("a".repeat(40_000)).catch(() => undefined);
    expect(sent().filter((call) => call.stdin !== undefined)).toEqual([]);
    expect(sent().filter((call) => call.env.SANDBOX_SDK_INPUT)).toEqual([]);

    // A small query still takes the one guest search, through the environment.
    await box.files.search("needle").catch(() => undefined);
    expect(sent().some((call) => call.env.SANDBOX_SDK_INPUT?.includes("needle"))).toBe(true);
  });

  it("declares the file flags of the SDK's own file layer", () => {
    const { files } = nativeSandbox({ apiKey: "fixture" });
    const provider = briq({ apiKey: "fixture" });
    expect(provider.files).toMatchObject({
      transfer: files.transfer,
      listOrder: files.listOrder,
      writeSupportsMode: files.writeSupportsMode,
    });
  });
});

describe("Briq credentials and peer", () => {
  it("falls back to BRIQ_API_KEY and BRIQ_API_URL, and lets options win", async () => {
    vi.stubEnv("BRIQ_API_KEY", "env-key");
    vi.stubEnv("BRIQ_API_URL", baseUrl);
    const seen: Array<{ url: string; auth: string | null }> = [];

    const fetcher: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });

      return Response.json({ briqs: [] });
    };

    await briq({ fetch: fetcher }).list({});
    await briq({ apiKey: "option-key", baseUrl: "http://127.0.0.1:9", fetch: fetcher }).list({});
    expect(seen.map((call) => new URL(call.url).origin)).toEqual([baseUrl, "http://127.0.0.1:9"]);
    expect(seen.map((call) => call.auth)).toEqual(["Bearer env-key", "Bearer option-key"]);
  });

  it("names the missing peer when @briq-cloud/sdk is not installed", async () => {
    const missing = Object.assign(new Error("Cannot find package '@briq-cloud/sdk'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    const provider = createBriqProvider({ apiKey: "fixture" }, () => Promise.reject(missing));
    const failure = await rejection(provider.list({}));
    expect(failure).toMatchObject({ code: "unavailable", provider: "briq" });
    expect(String(failure)).toContain("Install @briq-cloud/sdk");
  });
});

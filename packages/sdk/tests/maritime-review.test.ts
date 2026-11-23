// Regressions for the review of d422348: each block names the finding it pins.
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSandbox } from "../src/index.js";
import { SandboxError } from "../src/errors.js";
import { httpStatus } from "../src/http.js";
import type { ServerResponse } from "node:http";
import type { ExecInput } from "../src/provider.js";
import type { JsonValue } from "../src/shared/json.js";
import { maritime } from "../src/providers/maritime/index.js";
import { execDir, killer, wrapper } from "../src/providers/maritime/exec.js";
import { fakeServer, type FakeServer } from "./http-fake.js";
import { maritimeFake } from "./maritime-fake.js";

const run = promisify(execFile);

const apiKey = "mk_live_review_key_0123456789";
const secret = "mst_scripted_secret_0123456789";
const urlToken = "mut_scripted_token_0123456789";

let server: FakeServer;

beforeEach(async () => {
  server = await fakeServer();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.close();
});

const scripted = (extra: { apiKey?: string } = {}) =>
  maritime({ apiKey, baseUrl: server.url, requestTimeoutMs: 5000, ...extra });

const sandbox = (state = "running", extra: Record<string, JsonValue> = {}) => ({
  json: {
    id: "sbx-s",
    state,
    metadata: {},
    createdAt: "2026-11-23T20:46:00Z",
    dataPlaneUrl: `${server.url}/dp/sbx-s/v1`,
    secret,
    urlToken,
    ...extra,
  },
});

const event = (name: string, data: JsonValue) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const sse = { "content-type": "text/event-stream" };
const killed = { json: { state: "exited", exitCode: 0, signal: null } };

function execInput(command: string, extra: Partial<ExecInput> = {}) {
  const out: string[] = [];

  const input: ExecInput = {
    command,
    cwd: "/workspace",
    env: {},
    timeoutMs: 10_000,
    onChunk: (chunk) => out.push(chunk.text),
    ...extra,
  };

  return { input, out };
}

/** Everything an error shows: message, cause, hint and the status it carries. */
const shown = (error: SandboxError | undefined) =>
  `${error?.message} ${String(error?.cause)} ${error?.hint} ${JSON.stringify(httpStatus(error))}`;

/** The rejection of `work`, which must be a SandboxError. */
async function rejection(work: Promise<unknown> | undefined): Promise<SandboxError> {
  const error = await Promise.resolve(work).then(
    () => undefined,
    (cause: unknown) => cause,
  );

  if (!(error instanceof SandboxError)) throw new Error("expected a SandboxError rejection");

  return error;
}

/** Command submissions that carried this user command (the killer's own posts do not). */
const submissions = (route: string, command: string) =>
  server.calls(route).filter((r) => r.body.toString().includes(command));

describe("finding 1: credentials never reach a SandboxError", () => {
  test.each([
    ["the API key", apiKey],
    ["the sandbox secret", secret],
    ["the URL token", urlToken],
  ])("an SSE error whose code is %s is redacted", async (_name, leaked) => {
    server.on("GET /v1/sandboxes/{id}", sandbox());
    server.on(
      "POST /dp/{id}/v1/commands",
      (_request, response) => {
        response.writeHead(200, sse);
        response.end(event("stdout", "x") + event("error", { code: leaked, message: leaked }));
      },
      killed,
    );

    const error = await rejection(scripted().exec("sbx-s", execInput("x").input));

    expect(error).toMatchObject({ code: "outcome_unknown" });
    expect(shown(error)).not.toContain(leaked);
  });

  test("an HTTP error code and request ID holding unregistered mst_ and mut_ tokens are dropped", async () => {
    const code = "mst_unregistered_secret_0123456789";
    const requestId = "mut_unregistered_token_0123456789";

    server.on("POST /v1/sandboxes/{id}/pause", {
      status: 400,
      json: { code, message: `bad ${code} ${requestId}`, requestId },
      headers: { "x-request-id": requestId },
    });

    const p = scripted();
    const error = await rejection(p.pause?.("sbx-s"));

    expect(error).toBeInstanceOf(SandboxError);

    for (const token of [code, requestId]) expect(shown(error)).not.toContain(token);

    // A native call keeps the provider's message, scrubbed of the same token shapes.
    server.on("GET /v1/sandboxes/{id}/boom", {
      status: 400,
      json: { code: "invalid_request", message: `bad ${code} /?token=${requestId}` },
    });

    const native = await rejection(p.native("sbx-s").request("GET", "/sandboxes/{id}/boom"));

    expect(native).toBeInstanceOf(SandboxError);

    for (const token of [code, requestId]) expect(shown(native)).not.toContain(token);
  });
});

describe("finding 2: a cancel is confirmed or reported unknown", () => {
  const holding = { stream: [event("stdout", "x")], hold: true, headers: sse };
  const routeGone = { status: 404, json: { code: "resource_not_found" } };

  test("a kill route answering 404 resource_not_found while the sandbox is live is outcome_unknown", async () => {
    server.on("GET /v1/sandboxes/{id}", sandbox("running"));
    server.on("POST /dp/{id}/v1/commands", holding, routeGone);

    const error = await rejection(
      scripted().exec("sbx-s", execInput("sleep 100", { timeoutMs: 300 }).input),
    );

    expect(error).toMatchObject({ code: "outcome_unknown" });
  });

  test("the same 404 counts as a confirmed cancel only once a read says the sandbox ended", async () => {
    server.on("GET /v1/sandboxes/{id}", sandbox("running"), sandbox("ended"));
    server.on("POST /dp/{id}/v1/commands", holding, routeGone);

    expect(
      await scripted().exec("sbx-s", execInput("sleep 100", { timeoutMs: 300 }).input),
    ).toEqual({ exitCode: null, timedOut: true });
  });

  describe("guest scripts with an unusable bookkeeping directory", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "sdk-maritime-exec-"));
      // A regular file where the directory's parent should be: mkdir fails, for root too.
      await writeFile(join(root, "blocked"), "");
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const at = (script: string) => script.replaceAll(execDir, join(root, "blocked", "exec"));

    // dash (the image's sh) exits on a failed redirect of `:`; bash does not, so both are checked.
    test.each(["sh", "bash"])(
      "under %s the wrapper never runs the user's command, and exits non-zero",
      async (shell) => {
        const ran = join(root, "ran");

        const result = await run("setsid", [
          "-w",
          shell,
          "-c",
          at(wrapper),
          "--",
          root,
          `touch ${ran}`,
          "tag1",
        ]).then(
          () => 0,
          (error: { code?: number }) => error.code ?? -1,
        );

        expect(result).not.toBe(0);
        await expect(stat(ran)).rejects.toThrow();
      },
    );

    test.each(["sh", "bash"])(
      "under %s the killer exits non-zero instead of confirming a cancel it could not record",
      async (shell) => {
        const result = await run(shell, ["-c", at(killer), "--", "tag1"]).then(
          () => 0,
          (error: { code?: number }) => error.code ?? -1,
        );

        expect(result).not.toBe(0);
      },
    );
  });
});

describe("finding 3: an exec POST is submitted once", () => {
  test("a 307 on the exec POST is not followed", async () => {
    server.on("GET /v1/sandboxes/{id}", sandbox());
    server.on(
      "POST /dp/{id}/v1/commands",
      { status: 307, headers: { location: `${server.url}/elsewhere/commands` } },
      killed,
    );
    server.on("POST /elsewhere/commands", {
      stream: [event("result", { state: "exited", exitCode: 0, signal: null })],
      headers: sse,
    });

    const error = await rejection(scripted().exec("sbx-s", execInput("echo once-307").input));

    expect(error).toBeInstanceOf(SandboxError);
    expect(submissions("POST /dp/{id}/v1/commands", "once-307")).toHaveLength(1);
    expect(server.calls("POST /elsewhere/commands")).toHaveLength(0);
  });

  test.each([
    ["a bodyless 401", { status: 401 }],
    ["a 401 with a malformed body", { status: 401, body: "not json" }],
    ["a 401 with another code", { status: 401, json: { code: "scope_missing" } }],
  ])("%s on the exec POST is never resent", async (_name, reply) => {
    server.on("GET /v1/sandboxes/{id}", sandbox());
    server.on("POST /dp/{id}/v1/commands", reply, {
      stream: [event("result", { state: "exited", exitCode: 0, signal: null })],
      headers: sse,
    });

    const error = await rejection(scripted().exec("sbx-s", execInput("echo once-401").input));

    expect(error).toMatchObject({ code: "auth" });
    expect(submissions("POST /dp/{id}/v1/commands", "once-401")).toHaveLength(1);
  });

  test("a 401 carrying Maritime's unauthenticated code reads the rotated secret and sends once more", async () => {
    server.on("GET /v1/sandboxes/{id}", sandbox());
    server.on(
      "POST /dp/{id}/v1/commands",
      { status: 401, json: { code: "unauthenticated" } },
      {
        stream: [event("result", { state: "exited", exitCode: 0, signal: null })],
        headers: sse,
      },
    );

    expect(await scripted().exec("sbx-s", execInput("echo rotated").input)).toEqual({
      exitCode: 0,
      timedOut: false,
    });
    expect(submissions("POST /dp/{id}/v1/commands", "rotated")).toHaveLength(2);
  });
});

describe("finding 4: a snapshot answer must name this sandbox as its source", () => {
  const saved = (source: string | undefined): Record<string, string> =>
    source === undefined ? {} : { sourceSandboxId: source };

  const echoName =
    (source: string | undefined) => (request: { body: Buffer }, response: ServerResponse) => {
      const { name } = JSON.parse(request.body.toString());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ...saved(source), name }));
    };

  test("a save answered with another sandbox's snapshot is outcome_unknown", async () => {
    server.on("POST /v1/sandboxes/{id}/save", echoName("sbx-other"));
    server.on("GET /v1/snapshots/{name}", (request, response) => {
      const name = decodeURIComponent(request.url.split("/").pop() ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name, sourceSandboxId: "sbx-other" }));
    });

    await expect(scripted().snapshot?.("sbx-s")).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  test("a save answer without a source is checked by a read before it is accepted", async () => {
    server.on("POST /v1/sandboxes/{id}/save", echoName(undefined));
    server.on("GET /v1/snapshots/{name}", (request, response) => {
      const name = decodeURIComponent(request.url.split("/").pop() ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name, sourceSandboxId: "sbx-s" }));
    });

    const snap = await scripted().snapshot?.("sbx-s");

    expect(snap?.id).toMatch(/^sandbox-sdk-/);
    expect(server.calls("GET /v1/snapshots/{name}")).toHaveLength(1);
  });
});

describe("finding 7: create recovery", () => {
  // JSON.stringify leaves out an undefined `metadata`: the answer then has none.
  const created = (metadata: JsonValue | undefined) =>
    JSON.stringify({
      id: "sbx-made",
      state: "running",
      metadata,
      createdAt: "2026-11-23T20:46:00Z",
      dataPlaneUrl: `${server.url}/dp/sbx-made/v1`,
      secret,
    });

  const setupRuns = () =>
    server.on("POST /dp/{id}/v1/commands", {
      stream: [event("result", { state: "exited", exitCode: 0, signal: null })],
      headers: sse,
    });

  test.each([
    ["missing", undefined],
    ["malformed", "not an object"],
  ])(
    "a 201 whose metadata is %s is replayed with the same key to recover the owned sandbox",
    async (_n, metadata) => {
      server.on(
        "POST /v1/sandboxes",
        (_request, response) => {
          response.writeHead(201, { "content-type": "application/json" });
          response.end(created(metadata));
        },
        (request, response) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(created(JSON.parse(request.body.toString()).metadata));
        },
      );
      setupRuns();

      const info = await scripted().create({ labels: {} });
      const keys = server.calls("POST /v1/sandboxes").map((r) => r.headers["idempotency-key"]);

      expect(info.id).toBe("sbx-made");
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(server.calls("DELETE /v1/sandboxes/{id}")).toHaveLength(0);
    },
  );

  test("an abort during the capacity backoff sends no further create", async () => {
    server.on("POST /v1/sandboxes", { status: 503, json: { code: "out_of_capacity" } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    await expect(
      scripted().create({ labels: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(server.calls("POST /v1/sandboxes")).toHaveLength(1);
  });

  test("reconciliation starts no list page once its 30-second deadline has passed", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    let page = 0;

    server.on("POST /v1/sandboxes", { status: 500, json: { code: "internal_error" } });
    server.on("GET /v1/sandboxes", (_request, response) => {
      // Each page takes 11 seconds of the deadline.
      offset += 11_000;
      page++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [], nextCursor: page < 10 ? `c${page}` : null }));
    });

    await expect(scripted().create({ labels: {} })).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(server.calls("GET /v1/sandboxes").length).toBeLessThanOrEqual(3);
  });
});

describe("finding 8: a contradictory SSE result is never success", () => {
  test.each([
    ["exited with a signal", { state: "exited", exitCode: 0, signal: "SIGKILL" }],
    ["exited without an exit code", { state: "exited", exitCode: null, signal: "SIGKILL" }],
    ["killed with an exit code", { state: "killed", exitCode: 0, signal: "SIGKILL" }],
  ])("%s is outcome_unknown", async (_name, result) => {
    server.on("GET /v1/sandboxes/{id}", sandbox());
    server.on(
      "POST /dp/{id}/v1/commands",
      (_request, response) => {
        response.writeHead(200, sse);
        response.end(event("result", result));
      },
      killed,
    );

    await expect(scripted().exec("sbx-s", execInput("x").input)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
  });
});

describe("finding 9: a private preview follows credential rotation", () => {
  test("after the URL token rotates and box.native reads the sandbox, preview returns the new token", async () => {
    const fake = await maritimeFake();

    try {
      const box = await createSandbox(
        maritime({ apiKey: "fake-key", baseUrl: fake.url, requestTimeoutMs: 10_000 }),
      );

      try {
        const record = fake.sandboxes.get(box.id);

        if (!record) throw new Error("no sandbox");
        const before = new URL((await box.preview(3000)).url).searchParams.get("token");
        expect(before).toBe(record.urlToken);

        // Maritime rotates the sandbox's URL token; box.native reads the sandbox's current record.
        record.urlToken = "mut_rotated_token_0123456789";
        expect(await box.native.request("GET", "/sandboxes/{id}")).toMatchObject({ id: box.id });

        const after = new URL((await box.preview(3000, { path: "/health" })).url);

        expect(after.pathname).toBe("/health");
        expect(after.searchParams.getAll("token")).toEqual(["mut_rotated_token_0123456789"]);
      } finally {
        await box.destroy();
      }
    } finally {
      await fake.close();
    }
  });
});

describe("re-review regressions on 6d6fea6", () => {
  test("redacts credentials with a prefix such as error_ or request_ in HTTP code and requestId", async () => {
    const wrappedSecret = "mst_fixture_secret_123456789";
    const wrappedToken = "mut_fixture_preview_123456789";

    server.on("POST /v1/sandboxes/{id}/pause", {
      status: 400,
      json: {
        code: `error_${wrappedSecret}`,
        message: "bad input",
        requestId: `request_${wrappedToken}`,
      },
    });

    const error = await rejection(scripted().pause?.("sbx-s"));

    expect(shown(error)).not.toContain(wrappedSecret);
    expect(shown(error)).not.toContain(wrappedToken);
  });

  test("does not count an ended record for a different sandbox ID as kill confirmation", async () => {
    server.on("GET /v1/sandboxes/{id}", sandbox("running"), sandbox("ended", { id: "sbx-other" }));
    server.on(
      "POST /dp/{id}/v1/commands",
      (_request, response) => {
        response.writeHead(200, sse);
        response.write(event("stdout", "started\n"));
      },
      { status: 404, json: { code: "resource_not_found", message: "missing route" } },
      { status: 404, json: { code: "resource_not_found", message: "missing route" } },
    );

    const controller = new AbortController();

    const { input } = execInput("echo test", {
      signal: controller.signal,
      onChunk: () => controller.abort(),
    });

    await expect(scripted().exec("sbx-s", input)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
  });

  test("an exec POST answered 401 with sandbox_paused does not replay", async () => {
    server.on("GET /v1/sandboxes/{id}", sandbox());
    server.on("POST /dp/{id}/v1/commands", {
      status: 401,
      json: { code: "sandbox_paused", message: "paused" },
    });

    await expect(scripted().exec("sbx-s", execInput("once-only").input)).rejects.toBeInstanceOf(
      SandboxError,
    );
    expect(submissions("POST /dp/{id}/v1/commands", "once-only")).toHaveLength(1);
  });

  test("Maritime SSE accepts an exited command whose optional signal field is omitted", async () => {
    server.on("GET /v1/sandboxes/{id}", sandbox());
    server.on("POST /dp/{id}/v1/commands", (_request, response) => {
      response.writeHead(200, sse);
      response.end(event("result", { state: "exited", exitCode: 0 }));
    });

    await expect(
      scripted().exec("sbx-s", execInput("echo optional-signal").input),
    ).resolves.toEqual({ exitCode: 0, timedOut: false });
  });
});

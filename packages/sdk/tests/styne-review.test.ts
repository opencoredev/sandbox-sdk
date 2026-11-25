/**
 * Regressions from the Sol reviews of 5027098, 48c6037 and 1f69117: a delete is done only on Styne's own
 * `error_code` about the resource asked for. A route-level, undecodable or foreign 404, a 410 without an
 * ended code, a generic `code` field, or an answer about another sandbox or snapshot decides nothing, and
 * nothing Styne echoes back reaches an error unredacted.
 */
import { inspect } from "node:util";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import { styne } from "../src/providers/styne/index.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

let server: FakeServer;

beforeEach(async () => {
  server = await fakeServer();
});

afterEach(async () => server.close());

const id = "vmReview123";
const provider = () => styne({ apiKey: "review-fixture-api-key", baseUrl: server.url });

const error = (status: number, code: string) => ({
  status,
  json: { code: status, error_code: code, message: "said by styne", origin: "client" },
});

async function code(task: Promise<unknown>): Promise<string> {
  return task.then(
    () => "done",
    (cause: unknown) => (cause instanceof SandboxError ? cause.code : "other"),
  );
}

test("destroy is done only on 404 not_found or a 410 with an ended code", async () => {
  server.on(
    "DELETE /sandboxes/{id}",
    { status: 404 },
    { status: 404, body: "<html>not found</html>" },
    error(404, "route_not_found"),
    { status: 410 },
    error(410, "gone"),
    error(410, "sandbox_timeout"),
    error(410, "agent_exit"),
    error(404, "not_found"),
  );
  const p = provider();
  const results: string[] = [];

  for (let i = 0; i < 8; i++) results.push(await code(p.destroy(id)));

  expect(results).toEqual([
    "provider",
    "provider",
    "provider",
    "provider",
    "provider",
    "done",
    "done",
    "done",
  ]);
});

test("deleteSnapshot reads only Styne's 404 not_found as a missing snapshot", async () => {
  server.on(
    "DELETE /snapshots/{name}",
    { status: 404 },
    error(404, "route_not_found"),
    error(410, "sandbox_ended"),
    error(404, "not_found"),
  );
  const p = provider();
  const results: (string | boolean)[] = [];

  for (let i = 0; i < 4; i++)
    results.push(
      await p.deleteSnapshot!("sbx-review").then(
        (deleted) => deleted,
        (cause: unknown) => (cause instanceof SandboxError ? cause.code : "other"),
      ),
    );

  expect(results).toEqual(["provider", "provider", "provider", false]);
});

test("a delete is done only when Styne's own error_code names this sandbox or snapshot, or none", async () => {
  server
    .on(
      "DELETE /sandboxes/{id}",
      { status: 410, json: { code: 410, error_code: "sandbox_ended", sandboxID: "vmOther" } },
      { status: 404, json: { code: "not_found" } },
      { status: 404, json: { code: 404, error_code: "not_found", id: "vmOther" } },
      { status: 404, json: { code: 404, error_code: "not_found", sandboxID: id } },
    )
    .on(
      "DELETE /snapshots/{name}",
      { status: 404, json: { code: 404, error_code: "not_found", name: "sbx-other" } },
      { status: 404, json: { code: "not_found" } },
      { status: 404, json: { code: 404, error_code: "not_found", sandboxID: "vmOther" } },
      { status: 404, json: { code: 404, error_code: "not_found", name: "sbx-review" } },
    );
  const p = provider();
  const destroyed: string[] = [];
  const deleted: (string | boolean)[] = [];

  for (let i = 0; i < 4; i++) destroyed.push(await code(p.destroy(id)));

  for (let i = 0; i < 4; i++)
    deleted.push(
      await p.deleteSnapshot!("sbx-review").then(
        (done) => done,
        (cause: unknown) => (cause instanceof SandboxError ? cause.code : "other"),
      ),
    );

  expect(destroyed).toEqual(["provider", "provider", "provider", "done"]);
  expect(deleted).toEqual(["provider", "provider", "provider", false]);
});

test("reads and writes trust only Styne's own error_code and answers about the sandbox asked for", async () => {
  server
    .on(
      "GET /sandboxes/{id}",
      { status: 404, json: { code: "not_found" } },
      { json: { sandboxID: "vmOther", state: "running" } },
    )
    .on("POST /sandboxes/{id}/pause", { status: 409, json: { code: "already_paused" } })
    .on("POST /sandboxes/{id}/resume", {
      status: 201,
      json: { sandboxID: "vmOther", domain: "ash.styne.ai", trafficAccessToken: "other-token" },
    });
  const p = provider();

  expect(await code(p.connect(id))).toBe("provider");
  expect(await code(p.connect(id))).toBe("provider");
  expect(await code(p.pause!(id))).toBe("provider");
  expect(await code(p.resume!(id))).toBe("outcome_unknown");
});

test("a snapshot answer naming this name of another sandbox is never handed over", async () => {
  let asked = "";

  server
    .on("POST /sandboxes/{id}/snapshots", (request, response) => {
      asked = JSON.parse(request.body.toString()).name;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: asked, sandboxID: "vmOther" }));
    })
    .on("GET /snapshots/{name}", (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: asked, sandboxID: "vmOther" }));
    });

  expect(await code(provider().snapshot!(id))).toBe("outcome_unknown");
});

test("a key Styne echoes in a request ID, error_code or resource name never reaches the error", async () => {
  const key = "styne_review_key_0123";
  const echoed = { "x-request-id": key };

  server.on(
    "DELETE /sandboxes/{id}",
    { status: 404, headers: echoed, json: { error_code: "not_found", sandboxID: key } },
    { status: 409, headers: echoed, json: { error_code: key, id: key } },
    { status: 404, headers: echoed, json: { error_code: "not_found", name: key } },
  );
  const p = styne({ apiKey: key, baseUrl: server.url });

  for (let i = 0; i < 3; i++) {
    const caught = await p.destroy(id).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    if (!(caught instanceof SandboxError)) throw new Error("expected a SandboxError");

    for (const shown of [
      caught.message,
      String(caught),
      JSON.stringify(caught),
      inspect(caught, { depth: 10, showHidden: true }),
      String(caught.cause),
      JSON.stringify(caught.cause),
      inspect(caught.cause, { depth: 10, showHidden: true }),
    ])
      expect(shown).not.toContain(key);
  }
});

test("a foreign 404 or 410 is provider whatever its error_code, and not_found comes only from 404 or 410", async () => {
  server.on(
    "GET /sandboxes/{id}",
    { status: 404, json: { error_code: "permission_denied", sandboxID: "vmOther" } },
    { status: 410, json: { error_code: "quota_exceeded", id: "vmOther" } },
    { status: 409, json: { error_code: "not_found" } },
    { status: 400, json: { error_code: "sandbox_ended" } },
    { status: 404, json: { error_code: "permission_denied", sandboxID: id } },
  );
  const p = provider();
  const results: string[] = [];

  for (let i = 0; i < 5; i++) results.push(await code(p.connect(id)));

  expect(results).toEqual(["provider", "provider", "provider", "provider", "auth"]);
});

test("pause and resume accept already_paused or already_running only as a 409 about this sandbox", async () => {
  server
    .on(
      "POST /sandboxes/{id}/pause",
      { status: 404, json: { error_code: "already_paused", sandboxID: "vmOther" } },
      { status: 404, json: { error_code: "already_paused" } },
      { status: 409, json: { error_code: "already_paused", sandboxID: "vmOther" } },
      { status: 409, json: { error_code: "already_paused", sandboxID: id } },
      { status: 409, json: { error_code: "already_paused" } },
    )
    .on(
      "POST /sandboxes/{id}/resume",
      { status: 410, json: { error_code: "already_running" } },
      { status: 409, json: { error_code: "already_running", id: "vmOther" } },
      { status: 409, json: { error_code: "already_running", id } },
    );
  const p = provider();
  const paused: string[] = [];
  const resumed: string[] = [];

  for (let i = 0; i < 5; i++) paused.push(await code(p.pause!(id)));

  for (let i = 0; i < 3; i++) resumed.push(await code(p.resume!(id)));

  expect(paused).toEqual(["provider", "provider", "provider", "done", "done"]);
  expect(resumed).toEqual(["provider", "provider", "done"]);
});

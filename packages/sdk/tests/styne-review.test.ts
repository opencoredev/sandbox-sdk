/**
 * Regressions from the Sol review of 5027098: a delete is done only on Styne's own codes. A route-level
 * or undecodable 404, or a 410 without an ended code, says nothing about the sandbox or the snapshot.
 */
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

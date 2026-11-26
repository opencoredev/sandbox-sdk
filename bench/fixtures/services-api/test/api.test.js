// Integration tests: every test goes through real Postgres 16 and Redis 7 servers.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { connect, migrate, start } from "../src/app.js";
import { config } from "../src/config.js";

let services;
let server;
let base;

async function call(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

  return {
    status: response.status,
    cache: response.headers.get("x-cache"),
    body: await response.json(),
  };
}

const post = (body) => call("/notes", { method: "POST", body: JSON.stringify(body) });

before(async () => {
  services = await connect(config());
  await migrate(services.pool);
  server = await start({ services, port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  await services.pool.query("TRUNCATE notes RESTART IDENTITY");
  await services.redis.flushDb();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await services.close();
});

describe("services", () => {
  test("Postgres is major version 16", async () => {
    const { rows } = await services.pool.query("SHOW server_version_num");
    assert.equal(rows[0].server_version_num.slice(0, 2), "16");
  });

  test("Redis is major version 7", async () => {
    const info = await services.redis.info("server");
    assert.match(info, /redis_version:7\./);
  });

  test("health checks both services", async () => {
    const { status, body } = await call("/health");
    assert.equal(status, 200);
    assert.deepEqual(body, { postgres: "ok", redis: "ok" });
  });
});

describe("notes", () => {
  test("a note is stored in Postgres and its read is cached in Redis", async () => {
    const created = await post({ author: "ada", body: "first", tags: ["a", "b"] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.tags, ["a", "b"]);

    const { rows } = await services.pool.query("SELECT body, tags FROM notes WHERE id = $1", [
      created.body.id,
    ]);
    assert.deepEqual(rows[0], { body: "first", tags: ["a", "b"] });

    const miss = await call(`/notes/${created.body.id}`);
    assert.equal(miss.cache, "miss");
    const ttl = await services.redis.ttl(`note:${created.body.id}`);
    assert.ok(ttl > 0 && ttl <= 60, `ttl ${ttl}`);

    // Change the row behind the cache: a hit must come from Redis, not Postgres.
    await services.pool.query("UPDATE notes SET body = 'changed' WHERE id = $1", [created.body.id]);
    const hit = await call(`/notes/${created.body.id}`);
    assert.equal(hit.cache, "hit");
    assert.equal(hit.body.body, "first");
  });

  test("a new note invalidates its author's cached list", async () => {
    await post({ author: "grace", body: "one" });
    assert.equal((await call("/authors/grace/notes")).cache, "miss");
    assert.equal((await call("/authors/grace/notes")).cache, "hit");

    await post({ author: "grace", body: "two" });
    const fresh = await call("/authors/grace/notes");
    assert.equal(fresh.cache, "miss");
    assert.deepEqual(
      fresh.body.map((note) => note.body),
      ["one", "two"],
    );
  });

  test("posting is rate limited per author in Redis", async () => {
    for (let i = 0; i < 5; i++)
      assert.equal((await post({ author: "linus", body: `n${i}` })).status, 201);
    assert.equal((await post({ author: "linus", body: "n5" })).status, 429);
    assert.equal((await post({ author: "ken", body: "other author" })).status, 201);
    assert.equal(await services.redis.get("ratelimit:linus"), "6");
  });

  test("concurrent writes keep Postgres and the Redis counter in step", async () => {
    const authors = Array.from({ length: 20 }, (_, i) => `writer-${i}`);
    const results = await Promise.all(authors.map((author) => post({ author, body: "x" })));
    assert.ok(results.every((r) => r.status === 201));

    const stats = await call("/stats");
    assert.deepEqual(stats.body, { notes: 20, created: 20 });
  });

  test("a missing note is a 404 and is not cached", async () => {
    const { status } = await call("/notes/999");
    assert.equal(status, 404);
    assert.equal(await services.redis.exists("note:999"), 0);
  });

  test("a bad request is refused before touching either service", async () => {
    const { status } = await post({ author: "nobody" });
    assert.equal(status, 400);
    assert.equal(await services.redis.exists("ratelimit:nobody"), 0);
  });
});

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import pg from "pg";
import { createClient } from "redis";

const schemaUrl = new URL("../db/schema.sql", import.meta.url);
const noteTtlSeconds = 60;
const postsPerMinute = 5;

/** Open both connections. Callers close them with `services.close()`. */
export async function connect({ databaseUrl, redisUrl }) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => {});
  await redis.connect();

  return {
    pool,
    redis,
    async close() {
      await Promise.allSettled([pool.end(), redis.quit()]);
    },
  };
}

export async function migrate(pool) {
  await pool.query(await readFile(schemaUrl, "utf8"));
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];

  for await (const chunk of req) chunks.push(chunk);

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function toNote(row) {
  return {
    id: Number(row.id),
    author: row.author,
    body: row.body,
    tags: row.tags,
    createdAt: row.created_at.toISOString(),
  };
}

/** The HTTP handler: notes in Postgres, a read-through cache, counters and rate limits in Redis. */
export function handler({ pool, redis }) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        await pool.query("SELECT 1");
        await redis.ping();

        return send(res, 200, { postgres: "ok", redis: "ok" });
      }

      if (req.method === "POST" && url.pathname === "/notes") {
        const input = await readJson(req);

        if (typeof input.author !== "string" || typeof input.body !== "string")
          return send(res, 400, { error: "author and body are required" });

        const limitKey = `ratelimit:${input.author}`;
        const used = await redis.incr(limitKey);

        if (used === 1) await redis.expire(limitKey, 60);

        if (used > postsPerMinute) return send(res, 429, { error: "rate limited" });

        const { rows } = await pool.query(
          "INSERT INTO notes (author, body, tags) VALUES ($1, $2, $3) RETURNING *",
          [input.author, input.body, Array.isArray(input.tags) ? input.tags : []],
        );
        const note = toNote(rows[0]);
        await redis.multi().incr("stats:notes_created").del(`author:${note.author}:notes`).exec();

        return send(res, 201, note);
      }

      const noteMatch = /^\/notes\/(\d+)$/.exec(url.pathname);

      if (req.method === "GET" && noteMatch) {
        const key = `note:${noteMatch[1]}`;
        const cached = await redis.get(key);

        if (cached) return send(res, 200, JSON.parse(cached), { "x-cache": "hit" });

        const { rows } = await pool.query("SELECT * FROM notes WHERE id = $1", [noteMatch[1]]);

        if (!rows[0]) return send(res, 404, { error: "not found" });
        const note = toNote(rows[0]);
        await redis.set(key, JSON.stringify(note), { EX: noteTtlSeconds });

        return send(res, 200, note, { "x-cache": "miss" });
      }

      const authorMatch = /^\/authors\/([^/]+)\/notes$/.exec(url.pathname);

      if (req.method === "GET" && authorMatch) {
        const author = decodeURIComponent(authorMatch[1]);
        const key = `author:${author}:notes`;
        const cached = await redis.get(key);

        if (cached) return send(res, 200, JSON.parse(cached), { "x-cache": "hit" });

        const { rows } = await pool.query("SELECT * FROM notes WHERE author = $1 ORDER BY id", [
          author,
        ]);
        const notes = rows.map(toNote);
        await redis.set(key, JSON.stringify(notes), { EX: noteTtlSeconds });

        return send(res, 200, notes, { "x-cache": "miss" });
      }

      if (req.method === "GET" && url.pathname === "/stats") {
        const [{ rows }, created] = await Promise.all([
          pool.query("SELECT count(*)::int AS total FROM notes"),
          redis.get("stats:notes_created"),
        ]);

        return send(res, 200, { notes: rows[0].total, created: Number(created ?? 0) });
      }

      return send(res, 404, { error: "not found" });
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** Start the API on `port` (0: any free port). */
export async function start({ services, port }) {
  const server = createServer(handler(services));
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  return server;
}

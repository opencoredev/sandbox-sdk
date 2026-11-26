// Waits until Postgres answers `SELECT 1` and Redis answers PING, the same readiness test on both
// benchmark paths. Prints one JSON line with each service's ready time from this script's start.
// Usage: node scripts/wait-services.js [timeoutMs]
import pg from "pg";
import { createClient } from "redis";
import { config } from "../src/config.js";

const started = performance.now();
const timeoutMs = Number(process.argv[2] ?? 120_000);
const { databaseUrl, redisUrl } = config();
const errors = { postgres: null, redis: null };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postgresReady() {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });

  try {
    await client.connect();
    await client.query("SELECT 1");

    return true;
  } catch (error) {
    errors.postgres = error instanceof Error ? error.message : String(error);

    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function redisReady() {
  const client = createClient({
    url: redisUrl,
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  client.on("error", () => {});

  try {
    await client.connect();

    return (await client.ping()) === "PONG";
  } catch (error) {
    errors.redis = error instanceof Error ? error.message : String(error);

    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

async function until(check) {
  while (performance.now() - started < timeoutMs) {
    if (await check()) return Math.round(performance.now() - started);
    await sleep(100);
  }

  return null;
}

const [postgresMs, redisMs] = await Promise.all([until(postgresReady), until(redisReady)]);
process.stdout.write(`${JSON.stringify({ postgresMs, redisMs, errors })}\n`);
process.exitCode = postgresMs !== null && redisMs !== null ? 0 : 1;

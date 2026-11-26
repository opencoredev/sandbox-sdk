/** Connection settings. Both benchmark paths export the same two URLs. */
export function config(env = process.env) {
  return {
    databaseUrl: env.DATABASE_URL ?? "postgres://app:app@127.0.0.1:5432/postgres",
    redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
    port: Number(env.PORT ?? 0),
  };
}

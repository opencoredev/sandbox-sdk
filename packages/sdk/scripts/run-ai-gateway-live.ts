const target = process.argv[2];
if (target !== "local" && target !== "vercel") {
  throw new Error("Usage: bun scripts/run-ai-gateway-live.ts <local|vercel>");
}

if (!process.env.AI_GATEWAY_API_KEY) {
  throw new Error("AI_GATEWAY_API_KEY is required for the paid AI Gateway live test");
}

if (
  target === "vercel" &&
  !process.env.VERCEL_OIDC_TOKEN &&
  !(process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID)
) {
  throw new Error(
    "VERCEL_OIDC_TOKEN or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID is required",
  );
}

const testName = target === "local" ? "Local sandbox" : "Vercel sandbox";
const child = Bun.spawn(
  ["bun", "test", "tests/live/ai-gateway.test.ts", "--test-name-pattern", testName],
  {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, SANDBOX_SDK_LIVE_TESTS: "1" },
    stdout: "inherit",
    stderr: "inherit",
  },
);

process.exitCode = await child.exited;

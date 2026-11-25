import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // A test that does real I/O sets its own budget with `{ timeout }`. These defaults make a hung
    // test fail by name instead of at the test script's wall clock.
    testTimeout: 10_000,
    hookTimeout: 30_000,
    teardownTimeout: 10_000,
    // The suite shares machines with other work, so it never takes every core.
    maxWorkers: 4,
  },
});

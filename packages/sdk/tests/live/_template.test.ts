import { expect, test } from "bun:test";

test.skip("live example adapter: copy this file and gate on credentials", () => {
  expect(process.env.EXAMPLE_API_KEY).toBeDefined();
});

import { memory } from "../src/memory.js";
import { runConformance } from "../src/testing.js";

// One instance: memory state lives in the provider, so a fresh client must share it.
const provider = memory();

runConformance(() => provider, {
  live: false,
  unsupported: {
    gitPush: "memory runs no git",
    httpProbe: "memory preview URLs are placeholders",
  },
});

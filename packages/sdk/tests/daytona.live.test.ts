import { describe, vi } from "vitest";
import { daytona } from "../src/providers/daytona/index.js";
import { execute } from "../src/providers/daytona/exec.js";
import { runConformance } from "../src/testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// The whole suite, including Git and HTTP, runs only with explicit credentials.
describe.skipIf(!process.env.DAYTONA_API_KEY)("Daytona live", () => {
  runConformance(
    () => {
      const provider = daytona();
      const create = provider.create;
      provider.create = (input) =>
        create({
          ...input,
          labels: {
            ...input.labels,
            "sbx57-create-a-live": "1",
            "daytona-live-suite":
              process.env.DAYTONA_BUFFERED_TEST === "1" ? "buffered" : "session",
          },
        });

      if (process.env.DAYTONA_BUFFERED_TEST === "1")
        provider.exec = (id, input) => execute(provider.native(id), { ...input, streaming: false });

      return provider;
    },
    { live: true },
  );
});

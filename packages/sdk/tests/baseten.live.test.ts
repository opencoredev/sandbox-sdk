import { describe } from "vitest";
import { baseten } from "../src/providers/baseten/index.js";
import { runConformance } from "../src/testing.js";

// The default image, baseten/ts-app, is Debian with Node and Git, which the whole suite needs.
function liveProvider() {
  const provider = baseten({ image: process.env.SANDBOX_BASETEN_IMAGE });
  const create = provider.create;
  provider.create = (input) =>
    create({
      ...input,
      labels: {
        ...input.labels,
        "live-run": process.env.SANDBOX_TEST_RUN_ID ?? "baseten-conformance",
      },
    });

  return provider;
}

describe.skipIf(process.env.SANDBOX_BASETEN_LIVE !== "1" || !process.env.BASETEN_API_KEY)(
  "Baseten live",
  () => {
    runConformance(() => liveProvider(), { live: true });
  },
);

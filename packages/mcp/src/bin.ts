#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { providerName, providersFromEnv } from "./providers.js";
import { createSandboxMcpServer } from "./server.js";

// stdout carries the protocol, so everything a person reads goes to stderr.
try {
  const providers = providersFromEnv();
  const chosen = process.env.SANDBOX_PROVIDER?.trim();

  const server = createSandboxMcpServer({
    providers,
    // The same aliases SANDBOX_PROVIDERS accepts, so `docker` works in both.
    defaultProvider: chosen ? providerName(chosen) : undefined,
  });

  await server.connect(new StdioServerTransport());
  console.error(`sandbox-mcp ready. Providers: ${[...providers.keys()].join(", ")}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

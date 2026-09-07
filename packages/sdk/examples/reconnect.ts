import { connectSandbox, createSandbox, listSandboxes } from "../src";
import { e2b } from "../src/providers/e2b";

// Requires E2B_API_KEY. Vercel and Daytona support the same lifecycle surface.
const provider = e2b();

const first = await createSandbox({ provider });
await first.files.write("state.txt", "survives reconnects");
await first.extendTimeout(10 * 60 * 1000);

// Later, possibly from a different process:
await using reconnected = await connectSandbox({ provider, id: first.id });
console.log(await reconnected.files.text("state.txt"));

for (const summary of await listSandboxes(provider)) {
  console.log(summary.id, summary.state);
}

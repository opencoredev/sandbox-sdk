---
title: E2B self-hosted: E2B Embed, or Docker instead
description: Self-host E2B with E2B Embed on one Linux machine with KVM, point your TypeScript code at it, or run the same sandbox code in a local Docker container instead.
published: 2026-11-02
---

Yes, you can self-host E2B. Its runtime is open source under Apache-2.0, and [E2B Embed](https://github.com/e2b-dev/runtime/blob/main/embed/README.md) packages the whole stack, Firecracker microVMs included, to run on one Linux machine with KVM. You start it with Docker Compose, Terraform on GCP, AWS or Azure, or a Kubernetes manifest. Your code then talks to it through the same SDK and API as E2B Cloud.

Whether you should depends on why you want to. This guide covers what Embed runs and needs, how to point TypeScript code at it, and when a plain Docker container on your own machine is the simpler answer. With [Sandbox SDK](/) (`@opencoredev/sandbox-sdk`), the same sandbox code runs against E2B Cloud, a self-hosted E2B node and Docker, so you can start on one and move later.

## What E2B Embed is

E2B splits its platform into the runtime (the control-plane API, the per-node orchestrator that drives Firecracker, the daemon inside each VM, the edge router and the template builder) and the cloud service built on it. The runtime lives in the public [e2b-dev/runtime](https://github.com/e2b-dev/runtime) repository. Embed is that runtime packaged for one machine.

What you get, per E2B's README (checked November 2026):

- The same sandboxes as E2B Cloud, including pause and resume.
- The same SDK and API, so moving from E2B Cloud is a configuration change.
- Your own templates, built through the same API.
- The dashboard, with a terminal and file browser per sandbox.
- No E2B account and no license key.

Everything stays on that one machine: templates, logs and sandbox data live on its disk.

### What it needs

- Linux on x86-64 or arm64 with a 4 KiB-page kernel and hardware virtualization. `/dev/kvm` and `/dev/net/tun` must exist, so on a cloud VM you need nested virtualization or bare metal. The Terraform installs create a suitable VM for you.
- Ubuntu 24.04 is the recommended host. On arm64 the kernel must be 6.10 or newer: with Ubuntu 24.04's stock 6.8 kernel the stack starts but every sandbox fails to start until you install `linux-generic-hwe-24.04`. The guides were written and tested on x86-64.
- About 12 GiB of RAM and 20 GiB of free disk, per the [Compose guide](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md#requirements).
- On a Mac, it runs inside a Linux VM, which needs Apple silicon M3 or newer and macOS 15 or newer.

### What it doesn't do

- **It is one machine.** E2B says Embed is single-node by design. For more capacity, E2B points you to its enterprise options: a deployment in your own cloud account operated by E2B, or a private cloud that is still in development.
- **It serves plain HTTP.** Embed has no TLS of its own and answers at the machine's address, so it belongs inside your network. The Terraform installs only let in the client addresses you list.

## Run it with Docker Compose

On a Linux host that meets the requirements, E2B's quickstart is two files and one command:

```bash
mkdir e2b && cd e2b
curl -fsSL --remote-name-all "https://raw.githubusercontent.com/e2b-dev/runtime/main/embed/compose/{compose.yaml,.env}"
docker compose up -d --wait
```

When it is up, the stack writes the connection settings for its SDK clients, including an API key for this install. Load them into your shell:

```bash
eval "$(docker compose exec ready cat /run/e2b/sdk.env)"
```

That sets `E2B_API_KEY`, `E2B_API_URL` (port 3000), `E2B_SANDBOX_URL` (port 3002) and `E2B_DASHBOARD_URL` (port 3001). E2B's own SDKs read the first three, which is why existing E2B code moves over without changes. Every install guide in the repository, Terraform and Kubernetes included, ends with your first sandbox.

## Point your TypeScript code at it

With E2B's SDK, the code is the same as on E2B Cloud: create a sandbox and the environment variables decide where it runs.

Sandbox SDK's `e2b()` provider reads the same three variables. `E2B_API_KEY` authenticates, `E2B_API_URL` replaces the control-plane address, and `E2B_SANDBOX_URL` replaces the address of the daemon inside each sandbox that runs your commands and file operations. It talks to both over HTTP, so you don't install the `e2b` package.

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";

// E2B_API_KEY, E2B_API_URL and E2B_SANDBOX_URL come from sdk.env.
await using box = await createSandbox(e2b());

await box.files.write("main.py", 'print("hello from a self-hosted E2B sandbox")\n');
const result = await box.run("python3 main.py");
console.log(result.stdout);
```

Two things to know before you rely on this:

- This release of Sandbox SDK hasn't been tested against an Embed node yet. Run a smoke test of your own before you depend on it.
- `box.preview(port)` builds `https://<port>-<sandbox id>.<domain>` URLs, the form E2B Cloud serves. Embed answers over plain HTTP at the machine's address, so preview URLs from the SDK won't reach it. Embed's [reference](https://github.com/e2b-dev/runtime/blob/main/embed/docs/REFERENCE.md) explains how to reach a port inside a sandbox there.

Everything else in your code stays the same: `box.run`, `box.files`, `box.git`, processes, and the agent tools from `sandboxTools(box)`. [The E2B provider page](/docs/providers/e2b) lists every option, including `template`, `autoPause` and `volumes`.

## When Docker on your own machine is enough

If what you want is to run agent code on your own machine during development, or to keep it off a third-party cloud, and you don't need Firecracker, a Docker container may cover it with far less to operate.

Sandbox SDK's `local()` provider creates a container through the Docker Engine API and takes the same calls as `e2b()`:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { local } from "@opencoredev/sandbox-sdk/local";

await using box = await createSandbox(local());
const result = await box.run("python3 --version");
console.log(result.stdout);
```

It needs a running Docker Engine (Docker Desktop, OrbStack or Colima are fine) and nothing else. The trade-offs:

|                  | E2B Embed                         | Docker with `local()`                                     |
| ---------------- | --------------------------------- | --------------------------------------------------------- |
| Isolation        | A Firecracker microVM per sandbox | A container that shares the host's kernel                 |
| Host             | Linux with KVM, about 12 GiB RAM  | Any machine with a Docker Engine                          |
| Pause and resume | Yes, memory included              | Yes, with `docker pause`                                  |
| Templates        | Built through E2B's API           | Any image with `node`, `git`, `tar` and a few shell tools |
| Network limits   | Off, or an allow list of hosts    | Off only (`network: "none"`)                              |
| Preview URLs     | Through Embed's own port routing  | `http://127.0.0.1` on the Docker host                     |
| What you run     | The E2B stack and its dashboard   | Docker                                                    |

The isolation row is the one that matters most. A container is a fine boundary for your own agent working on your own repositories, in development and in CI. For code from strangers on a machine that holds secrets, you want a microVM, which is what Embed or a cloud provider gives you. `local({ runtime: "runsc" })` narrows the gap with gVisor if your Docker daemon has it registered. The [security reference](/docs/reference/security) covers the trust boundaries in more detail, and [Docker sandbox for AI agents in TypeScript](/blog/docker-sandbox-for-ai-agents) walks through locking a container down.

If you want neither Docker nor a VM, [agentOS](/docs/providers/agentos) runs command and file tasks on your own machine.

## Same code on all three

Because the providers share one API, the choice can be configuration. One common setup is Docker on a laptop, a self-hosted E2B node in staging or for customers who need their data kept in place, and E2B Cloud in production:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";
import { local } from "@opencoredev/sandbox-sdk/local";

// With E2B_API_URL set, e2b() talks to your own node; without it, to E2B Cloud.
const provider = process.env.SANDBOX === "docker" ? local() : e2b();

await using box = await createSandbox(provider);
```

Options that a provider can't enforce fail with an `unsupported` error instead of being ignored, so the same code never quietly gets a looser sandbox. Check the [capability matrix](/docs/reference/capabilities) for what each provider accepts, and [Choose a provider](/docs/getting-started/choose-a-provider) if you are still deciding. For speed and price comparisons between hosted providers, see [AI Sandbox Bench](https://aisandboxbench.com).

## Test without either

Unit tests shouldn't need an E2B node or Docker. `memory()` runs a fake sandbox inside your test process, with commands answered by handlers you write:

```ts
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

const provider = memory({
  handlers: {
    python3: async ({ stdout }) => {
      stdout("ok\n");
      return 0;
    },
  },
});

await using box = await createSandbox(provider);
console.log((await box.run("python3 main.py")).stdout); // ok
```

[Testing with memory()](/docs/guides/testing-with-memory) covers the handler API.

## Common questions

**Is E2B open source?** The runtime and Embed are, under Apache-2.0, in [e2b-dev/runtime](https://github.com/e2b-dev/runtime). The SDKs and CLI are in [e2b-dev/E2B](https://github.com/e2b-dev/E2B).

**Can I self-host E2B across several machines?** Not with Embed, which is one machine by design. For more, E2B points to [Bring Your Own Cloud](https://e2b.dev/enterprise), where E2B operates the platform in your cloud account, and to a private cloud option still in development.

**Do I need to change my E2B code to use a self-hosted node?** No, if you set `E2B_API_URL` and `E2B_SANDBOX_URL` with the install's own `E2B_API_KEY`. That holds for E2B's SDKs and for Sandbox SDK's `e2b()`. Preview URLs are the exception covered above.

**Does a self-hosted sandbox clean up after itself?** With Sandbox SDK, `await using` destroys the sandbox when the block ends, including when your code throws. [Lifecycle and cleanup](/docs/concepts/lifecycle-and-cleanup) explains `close`, `destroy`, timeouts and the reaper for sandboxes your app forgot.

## Next steps

- [Quickstart](/docs/getting-started/quickstart): your first sandbox in memory, then in Docker, then in the cloud.
- [Running commands](/docs/concepts/running-commands): output, exit codes, streaming and timeouts.
- [Give your agent a sandbox](/docs/guides/give-your-agent-a-sandbox): hand the sandbox to an agent as tools.
- [Write a provider](/docs/providers/custom): wrap any other sandbox backend in the same API.

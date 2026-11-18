import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SandboxError,
  connectSandbox,
  createSandbox,
  hasCapability,
  listSandboxes,
  type Sandbox,
} from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import {
  createSandboxTools,
  toolDescriptions,
  toolSchemas,
  type SandboxToolsOptions,
  type ToolName,
} from "@opencoredev/sandbox-sdk/tools";
import { z } from "zod";
import type { ProviderLoader } from "./providers.js";

export interface SandboxMcpServerOptions {
  /** Providers by name, in order of preference. Each loads on first use. */
  providers: ReadonlyMap<string, ProviderLoader>;
  /** Provider used when a call names none. Default: the first one. */
  defaultProvider?: string;
  /** Policy and limits for the per-sandbox tools: `beforeRun`, `limits`, `deny`. */
  tools?: Pick<SandboxToolsOptions, "beforeRun" | "limits" | "deny">;
}

/** The per-sandbox tools. `changes` is left out: its baseline belongs to one long-lived handle. */
const boxTools: ToolName[] = [
  "run",
  "read_file",
  "write_file",
  "edit_file",
  "start_process",
  "process_logs",
  "stop_process",
  "search",
  "list_files",
  "preview",
];

const sandboxRef = z
  .string()
  .regex(/^[a-z0-9-]+:.+$/)
  .describe('A sandbox reference from create_sandbox or list_sandboxes, such as "e2b:abc123".');

const providerName = z
  .string()
  .optional()
  .describe("Provider name from list_providers. Default: the server's default provider.");

type Reply = { content: { type: "text"; text: string }[]; isError: boolean };

const reply = (ok: boolean, text: string): Reply => ({
  content: [{ type: "text", text: `${ok ? "OK" : "FAILED"}\noutput:\n${text}` }],
  isError: !ok,
});

/** Failures come back as results the model can act on, never as protocol errors. */
async function attempt(action: () => Promise<string>): Promise<Reply> {
  try {
    return reply(true, await action());
  } catch (error) {
    if (error instanceof SandboxError)
      return reply(
        false,
        `${error.message}\ncode=${error.code} retryable=${error.retryable}\nNext: ${error.hint}`,
      );

    return reply(false, error instanceof Error ? error.message : "Unexpected failure");
  }
}

/**
 * An MCP server that creates and drives sandboxes on any configured provider. Sandboxes outlive the
 * server: a reference stays valid across restarts, and nothing is destroyed until `destroy_sandbox`.
 */
export function createSandboxMcpServer(options: SandboxMcpServerOptions): McpServer {
  const names = [...options.providers.keys()];
  const fallback = options.defaultProvider ?? names[0];

  if (!fallback || !options.providers.has(fallback))
    throw new Error("No sandbox provider configured. Pass at least one provider");

  const server = new McpServer({ name: "sandbox", version: "0.1.0" });
  const loaded = new Map<string, Promise<Provider>>();
  const handles = new Map<string, Promise<Sandbox>>();
  const tools = new Map<string, ReturnType<typeof createSandboxTools>>();

  function provider(name = fallback): Promise<Provider> {
    const key = name ?? "";
    const load = options.providers.get(key);

    if (!load)
      throw new SandboxError(`Unknown provider "${key}". Configured: ${names.join(", ")}`, {
        code: "invalid_argument",
      });
    let pending = loaded.get(key);

    if (!pending) {
      pending = Promise.resolve(load());
      loaded.set(key, pending);
      // A failed load (a missing peer package, say) is retried on the next call.
      pending.catch(() => loaded.delete(key));
    }

    return pending;
  }

  /** Reattach by reference. Handles are cached, so process records and replay windows survive. */
  function open(ref: string): Promise<Sandbox> {
    let pending = handles.get(ref);

    if (!pending) {
      const at = ref.indexOf(":");

      pending = provider(ref.slice(0, at)).then((p) => connectSandbox(p, ref.slice(at + 1)));
      handles.set(ref, pending);
      pending.catch(() => handles.delete(ref));
    }

    return pending;
  }

  function forget(ref: string) {
    handles.delete(ref);
    tools.delete(ref);
  }

  server.registerTool(
    "list_providers",
    {
      description:
        "List the sandbox providers this server can use and what each supports. Call it before create_sandbox when the provider matters.",
      inputSchema: z.object({}).strict(),
    },
    () =>
      attempt(async () => {
        const rows = await Promise.all(
          names.map(async (name) => {
            try {
              const p = await provider(name);

              return `${name}${name === fallback ? " (default)" : ""}: ${[...p.capabilities].sort().join(", ") || "core only"}`;
            } catch (error) {
              return `${name}: unavailable (${error instanceof Error ? error.message : "load failed"})`;
            }
          }),
        );

        return rows.join("\n");
      }),
  );

  server.registerTool(
    "create_sandbox",
    {
      description:
        "Create a sandbox, or reattach to the one with the same key. Returns the reference every other tool takes. The sandbox keeps running until destroy_sandbox, the provider's lifetime, or timeoutMinutes.",
      inputSchema: z
        .object({
          provider: providerName,
          key: z
            .string()
            .optional()
            .describe("A stable name. The same key returns the same sandbox instead of a new one."),
          size: z.enum(["small", "medium", "large"]).optional(),
          timeoutMinutes: z.number().int().positive().optional(),
          ports: z.array(z.number().int().min(1).max(65535)).optional(),
        })
        .strict(),
    },
    (input) =>
      attempt(async () => {
        const name = input.provider ?? fallback;

        const box = await createSandbox(await provider(name), {
          key: input.key,
          size: input.size,
          ports: input.ports,
          timeoutMs: input.timeoutMinutes ? input.timeoutMinutes * 60_000 : undefined,
        });

        const ref = `${name}:${box.id}`;
        forget(ref);
        handles.set(ref, Promise.resolve(box));

        return `sandbox=${ref} created=${box.created}${box.key ? ` key=${box.key}` : ""}`;
      }),
  );

  server.registerTool(
    "list_sandboxes",
    {
      description:
        "List sandboxes created through Sandbox SDK on a provider, with their state. Use it to find a sandbox from an earlier session.",
      inputSchema: z.object({ provider: providerName }).strict(),
    },
    (input) =>
      attempt(async () => {
        const name = input.provider ?? fallback;
        const found = await listSandboxes(await provider(name));

        if (!found.length) return `No sandboxes on ${name}`;

        return found
          .map(
            (info) =>
              `sandbox=${name}:${info.id} state=${info.state}${info.key ? ` key=${info.key}` : ""} created=${new Date(info.createdAt).toISOString()}`,
          )
          .join("\n");
      }),
  );

  const lifecycle = {
    pause_sandbox:
      "Pause a sandbox to stop paying for it while keeping its state. Not every provider supports it; list_providers shows which.",
    resume_sandbox: "Resume a paused sandbox before running anything in it.",
    destroy_sandbox:
      "Delete a sandbox and everything in it. This cannot be undone. Do not use it to stop a process; use stop_process.",
  };

  for (const [tool, description] of Object.entries(lifecycle)) {
    server.registerTool(
      tool,
      { description, inputSchema: z.object({ sandbox: sandboxRef }).strict() },
      (input) =>
        attempt(async () => {
          const box = await open(input.sandbox);

          if (tool === "destroy_sandbox") {
            await box.destroy();
            forget(input.sandbox);

            return `destroyed ${input.sandbox}`;
          }

          if (!hasCapability(box, "pause"))
            throw new SandboxError(`${box.provider} cannot pause sandboxes`, {
              code: "unsupported",
            });
          await (tool === "pause_sandbox" ? box.pause() : box.resume());

          return `${tool === "pause_sandbox" ? "paused" : "resumed"} ${input.sandbox}`;
        }),
    );
  }

  for (const tool of boxTools) {
    if (options.tools?.deny?.includes(tool)) continue;
    const schema = toolSchemas[tool];

    server.registerTool(
      tool,
      {
        description: `${toolDescriptions[tool]} Runs in the sandbox named by \`sandbox\`.`,
        inputSchema: z.object({ sandbox: sandboxRef, ...schema.shape }).strict(),
      },
      async (input, extra) => {
        const { sandbox, ...rest } = input;

        try {
          let definitions = tools.get(sandbox);

          if (!definitions) {
            definitions = createSandboxTools(await open(sandbox), {
              ...options.tools,
              allow: boxTools,
            });
            tools.set(sandbox, definitions);
          }

          const found = definitions.find((candidate) => candidate.name === tool);

          if (!found) return reply(false, `Tool ${tool} is disabled on this server`);
          const result = await found.execute(schema.parse(rest), undefined, extra.signal);

          return {
            content: [{ type: "text" as const, text: result.text }],
            isError: result.text.startsWith("FAILED"),
          };
        } catch (error) {
          return attempt(() => Promise.reject(error));
        }
      },
    );
  }

  return server;
}

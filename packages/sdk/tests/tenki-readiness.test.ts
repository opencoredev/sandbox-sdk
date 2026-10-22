import { createRequire } from "node:module";
import { TenkiSandbox } from "@tenkicloud/sandbox";
import { expect, test, vi } from "vitest";
import { waitReady } from "../src/providers/tenki/ready.js";

// Exercise the installed SDK and its own protocol dependency, without adding
// production dependencies just for this in-memory transport.
const nativeRequire = createRequire(createRequire(import.meta.url).resolve("@tenkicloud/sandbox"));
const { fromJson } = await import(nativeRequire.resolve("@bufbuild/protobuf"));
type Transport = NonNullable<
  NonNullable<ConstructorParameters<typeof TenkiSandbox>[0]>["transport"]
>;

function nativeSession(runningFrame: boolean) {
  const queried = vi.fn();
  const cancelled = vi.fn();
  const transport: Transport = {
    async unary(method) {
      if (method.name === "GetSession") queried();
      return {
        stream: false,
        service: method.parent,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message: fromJson(method.output, {
          session: { id: "offline-session", state: method.name === "CreateSession" ? 1 : 3 },
        }),
      };
    },
    async stream(method, signal) {
      return {
        stream: true,
        service: method.parent,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message: (async function* () {
          try {
            if (runningFrame)
              yield fromJson(method.output, { session: { id: "offline-session", state: 3 } });
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve();
              else signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          } finally {
            cancelled();
          }
        })(),
      };
    },
  };
  return { client: new TenkiSandbox({ authToken: "tk_offline", transport }), queried, cancelled };
}

test("native RUNNING without stream EOF succeeds within the readiness budget without a polling RPC", async () => {
  const { client, queried, cancelled } = nativeSession(true);
  const session = await client.create({ waitReady: false });
  await expect(waitReady(session, 200)).resolves.toBeUndefined();
  expect(session.state).toBe("RUNNING");
  expect(queried).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});

test("a silent native readiness stream is cancelled and falls back to bounded polling", async () => {
  const { client, queried, cancelled } = nativeSession(false);
  const session = await client.create({ waitReady: false });
  await expect(waitReady(session, 200)).resolves.toBeUndefined();
  expect(session.state).toBe("RUNNING");
  expect(queried).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
});

test("caller abort wins over a RUNNING frame without stream EOF", async () => {
  const { client, queried } = nativeSession(true);
  const session = await client.create({ waitReady: false });
  const controller = new AbortController();
  const pending = waitReady(session, 200, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
  expect(queried).not.toHaveBeenCalled();
});

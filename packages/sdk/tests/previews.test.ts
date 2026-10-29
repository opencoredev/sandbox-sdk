import { expect, test, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { createSandbox } from "../src/index.js";
import { shellProvider } from "./shell-provider.js";

function isTcpAddress(address: string | AddressInfo | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

test("private preview probes retain same-origin redirect cookies", async () => {
  const box = await createSandbox(await shellProvider());

  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (new Headers(init?.headers).get("cookie") === "preview=session") return new Response("ok");

    return new Response(null, {
      status: 302,
      headers: { location: "/ready", "set-cookie": "preview=session; Path=/; HttpOnly" },
    });
  });

  try {
    expect((await box.preview(3000, { waitMs: 300 })).url).toContain("unused.invalid");
  } finally {
    fetcher.mockRestore();
    await box.destroy();
  }
});

test("preview probes never forward provider headers to a redirect on another origin", async () => {
  const { createServer } = await import("node:http");
  let forwarded = 0;

  const target = createServer((_req, res) => {
    forwarded++;
    res.end("wrong origin");
  });

  const source = createServer((_req, res) => {
    const address = target.address();

    if (!isTcpAddress(address)) throw new Error("Missing target");
    res.writeHead(302, { location: `http://127.0.0.1:${address.port}/` });
    res.end();
  });

  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const address = source.address();

  if (!isTcpAddress(address)) throw new Error("Missing source");
  const provider = await shellProvider();

  const box = await createSandbox({
    ...provider,
    previewUrl: async () => ({
      url: `http://127.0.0.1:${address.port}/`,
      headers: { "X-Preview-Token": "private-preview-token" },
    }),
  });

  try {
    await expect(box.preview(3000, { waitMs: 100 })).rejects.toMatchObject({
      code: "port_not_ready",
    });
    expect(forwarded).toBe(0);
  } finally {
    await box.destroy();
    await Promise.all(
      [source, target].map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
});

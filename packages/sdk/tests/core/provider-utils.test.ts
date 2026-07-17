import { expect, mock, test } from "bun:test";
import { authenticatedPortRequest } from "../../src/internal/provider-utils";

test("authenticated port requests reject another origin", async () => {
  await expect(
    authenticatedPortRequest(
      "test",
      "https://preview.example.test",
      "https://attacker.example",
      {},
      { authorization: "secret" },
    ),
  ).rejects.toMatchObject({ code: "invalid_input" });
});

test("authenticated port requests do not automatically follow redirects", async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    const response = await authenticatedPortRequest(
      "test",
      "https://preview.example.test",
      "/redirect",
      { redirect: "follow" },
      { authorization: "secret" },
    );
    expect(response.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

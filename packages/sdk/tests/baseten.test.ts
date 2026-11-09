import { afterEach, beforeEach, expect, test } from "vitest";
import { baseten } from "../src/providers/baseten/index.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

let server: FakeServer;

beforeEach(async () => {
  server = await fakeServer();
});

afterEach(() => server.close());

const provider = () => baseten({ apiKey: "bt-key", baseUrl: server.url });

const later = () => new Date(Date.now() + 60 * 60_000).toISOString();
const minted = (token: string) => ({ json: { token, expires_at: later() } });

/** A management API sandbox record whose execution API is served under /sbx on the same fake server. */
const record = (name: string, status = "DEPLOYED", labels: Record<string, string> = {}) => ({
  name,
  status,
  created_at: "2026-11-09T00:00:00Z",
  url: `${server.url}/sbx`,
  labels: { "sandbox-sdk": "1", ...labels },
});

const instance = "/v1/sandboxes/instances/{sandboxName}";

const body = (index: number, route: string) =>
  JSON.parse(server.calls(route)[index]!.body.toString());

test("the access token is minted once from the API key and reused", async () => {
  server.on("POST /v1/token", minted("tok-1")).on(`GET ${instance}`, { json: record("box") });

  const sandboxes = provider();
  await sandboxes.connect("box");
  await sandboxes.connect("box");

  expect(server.calls("POST /v1/token")).toHaveLength(1);
  expect(server.calls("POST /v1/token")[0]!.headers.authorization).toBe("Bearer bt-key");
  expect(body(0, "POST /v1/token")).toEqual({ scopes: ["sandboxes"] });
  expect(server.calls(`GET ${instance}`).map((call) => call.headers.authorization)).toEqual([
    "Bearer tok-1",
    "Bearer tok-1",
  ]);
});

test("a 401 drops the access token and the retry mints a new one", async () => {
  server
    .on("POST /v1/token", minted("tok-1"), minted("tok-2"))
    .on(`GET ${instance}`, { status: 401, json: { error: "expired" } }, { json: record("box") });

  expect(await provider().connect("box")).toMatchObject({ id: "box", state: "running" });
  expect(server.calls("POST /v1/token")).toHaveLength(2);
  expect(server.calls(`GET ${instance}`).map((call) => call.headers.authorization)).toEqual([
    "Bearer tok-1",
    "Bearer tok-2",
  ]);
});

test("create sends the size as memory, lifecycle policies, labels and ports, then creates /workspace", async () => {
  server
    .on("POST /v1/token", minted("tok"))
    .on("POST /v1/sandboxes/instances", (request, response) => {
      const sent = JSON.parse(request.body.toString());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(record(sent.name, "DEPLOYED", sent.labels)));
    })
    .on("PUT /sbx/filesystem/{path}", { json: {} });

  const info = await provider().create({
    key: "user:1",
    labels: { app: "x" },
    env: { A: "1" },
    size: "large",
    ports: [3000],
    timeoutMs: 90_500,
    idleTimeoutMs: 60_000,
  });

  const sent = body(0, "POST /v1/sandboxes/instances");

  expect(info.id).toMatch(/^sbxsdk-[0-9a-f]{20}$/);
  expect(info).toMatchObject({ key: "user:1", state: "running" });
  expect(sent).toMatchObject({
    name: info.id,
    image: "baseten/ts-app:latest",
    memory: 8192,
    labels: { app: "x", "sandbox-sdk": "1", "sandbox-sdk-key": "user:1" },
    envs: [{ name: "A", value: "1" }],
    ports: [{ name: "port-3000", protocol: "HTTP", target: 3000 }],
    lifecycle: {
      expiration_policies: [
        { action: "DELETE", type: "TTL_MAX_AGE", value: "91s" },
        { action: "DELETE", type: "TTL_IDLE", value: "60s" },
      ],
    },
  });
  expect(server.calls("PUT /sbx/filesystem/{path}")[0]!.url).toBe("/sbx/filesystem/%2Fworkspace");
});

test("without a size, create uses the factory memory and sends no lifecycle", async () => {
  server
    .on("POST /v1/token", minted("tok"))
    .on("POST /v1/sandboxes/instances", (request, response) => {
      const sent = JSON.parse(request.body.toString());
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(record(sent.name)));
    })
    .on("PUT /sbx/filesystem/{path}", { json: {} });

  await provider().create({ labels: {}, size: { cpu: 3, memoryMb: 6144 } });
  await provider().create({ labels: {} });

  expect(body(0, "POST /v1/sandboxes/instances").memory).toBe(6144);
  expect(body(1, "POST /v1/sandboxes/instances").memory).toBe(4096);
  expect(body(1, "POST /v1/sandboxes/instances").lifecycle).toBeUndefined();
});

test("sizes Baseten can't express, network policies and snapshots fail before any request", async () => {
  for (const input of [
    { size: { cpu: 2, memoryMb: 3072 } },
    { size: { cpu: 2, memoryMb: 4096, diskGb: 20 } },
    { size: { cpu: 256, memoryMb: 524_288 } },
    { network: "none" as const },
    { from: "snap" },
  ])
    await expect(provider().create({ labels: {}, ...input })).rejects.toMatchObject({
      code: "unsupported",
    });
  expect(server.requests).toEqual([]);
});

test("a private preview puts its token in the URL", async () => {
  server
    .on("POST /v1/token", minted("tok"))
    .on(`POST ${instance}/previews`, {
      json: { name: "private-3000", url: "https://p.sandbox.example/app?x=1" },
    })
    .on(`POST ${instance}/previews/{previewName}/tokens`, { json: { token: "pt" } });

  const before = Date.now();
  const preview = await provider().previewUrl("box", 3000);

  expect(preview.url).toBe("https://p.sandbox.example/app?x=1&preview_token=pt");
  expect(preview.headers).toBeUndefined();
  expect(preview.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
  expect(body(0, `POST ${instance}/previews`)).toEqual({
    port: 3000,
    public: false,
    create_if_not_exists: true,
  });
  expect(server.calls(`POST ${instance}/previews/{previewName}/tokens`)[0]!.url).toBe(
    "/v1/sandboxes/instances/box/previews/private-3000/tokens",
  );
});

test("a public preview mints no token", async () => {
  server.on("POST /v1/token", minted("tok")).on(`POST ${instance}/previews`, {
    json: { name: "public-3000", url: "https://p.sandbox.example/" },
  });

  const preview = await baseten({
    apiKey: "bt-key",
    baseUrl: server.url,
    previewAccess: "public",
  }).previewUrl("box", 3000);

  expect(preview).toEqual({ url: "https://p.sandbox.example/" });
  expect(body(0, `POST ${instance}/previews`)).toMatchObject({ public: true });
  expect(server.calls(`POST ${instance}/previews/{previewName}/tokens`)).toEqual([]);
});

test("destroy treats an already deleted sandbox as done", async () => {
  server
    .on("POST /v1/token", minted("tok"))
    .on(`DELETE ${instance}`, { status: 404, json: { error: "not found" } });

  await expect(provider().destroy("gone")).resolves.toBeUndefined();
  expect(server.calls(`DELETE ${instance}`)).toHaveLength(1);
});

test("list follows pages and keeps only live SDK sandboxes", async () => {
  server.on("POST /v1/token", minted("tok")).on(
    "GET /v1/sandboxes/instances",
    {
      json: {
        items: [record("a", "DEPLOYED", { "sandbox-sdk-key": "k" }), record("b", "TERMINATED")],
        pagination: { has_more: true, cursor: "next" },
      },
    },
    {
      json: {
        items: [{ ...record("c"), labels: {} }, record("d", "DEACTIVATED")],
        pagination: { has_more: false },
      },
    },
  );

  expect((await provider().list({})).map((box) => box.id)).toEqual(["a", "d"]);
  expect(server.calls("GET /v1/sandboxes/instances")[1]!.url).toContain("cursor=next");
});

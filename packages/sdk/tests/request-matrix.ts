// Records what each adapter sends for a matrix of configurations: every HTTP request it makes
// (method, URL, headers with credentials replaced by their names) and every argument it hands its
// provider's own SDK. `request-parity.test.ts` runs it against this tree and against the commit
// before `resolveConfig` existed, and the two recordings must be equal.
//
//   bun tests/request-matrix.ts <path to an SDK src directory>
//
// No request leaves the process: `fetch` is replaced, provider SDKs the adapters load are replaced
// by recording fakes (except `@vercel/sandbox`, which only calls `fetch`), and a socket opened
// any other way is recorded as an escape and fails the comparison.
import net from "node:net";
import tls from "node:tls";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourceArgument = process.argv[2];

if (!sourceArgument) throw new Error("Usage: bun tests/request-matrix.ts <sdk src directory>");

const source = isAbsolute(sourceArgument) ? sourceArgument : resolve(sourceArgument);

/** Fake credentials, each reported by name, never by value. */
const secrets = {
  optionKey: "opt-key-0123456789abcdef",
  envKey: "env-key-0123456789abcdef",
  envToken: "env-token-0123456789abcdef",
  optionToken: "opt-token-0123456789abcdef",
  jwt: "jwt-0123456789abcdef",
  superserveUsw: "ss_live_usw_0123456789abcdef0123456789abcdef",
} as const;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function label(text: string): string {
  let out = text;

  for (const [name, value] of Object.entries(secrets)) out = out.replaceAll(value, `<${name}>`);

  // Random request IDs, idempotency keys and timestamps differ between any two runs.
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>");
}

const recorders = new WeakSet<object>();

function isFunction(value: unknown): value is (...args: never[]) => void {
  return typeof value === "function";
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isSymbol(key: string | symbol): key is symbol {
  return typeof key === "symbol";
}

function isRecord(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON copy of what an adapter passed, taken when it passed it: secrets labelled, keys sorted,
 * and what JSON drops (undefined, functions, fakes, signals) named, so recordings compare by value.
 */
function snapshot(args: readonly JsonValue[]): JsonValue {
  const text = JSON.stringify(args, (_key, value) => {
    if (value === undefined) return "<undefined>";

    if (isFunction(value)) return recorders.has(value) ? "<fake>" : `<function ${value.name}>`;

    if (value instanceof AbortSignal) return "<signal>";

    if (isText(value)) return label(value);

    if (isRecord(value))
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, value[key] ?? "<undefined>"]),
      );

    return value;
  });

  const copy: JsonValue = JSON.parse(text);

  return copy;
}

interface Recording {
  /** Each request or SDK call, in order. */
  events: JsonValue[];
}

let current: Recording = { events: [] };

/** A stand-in for any SDK export: constructing or calling it records the arguments. */
/** Every member of a fake is another fake; the type says only that it can be called. */
type FakeExport = () => void;

function fake(path: string): FakeExport {
  const target = function fakeExport() {};

  const proxy = new Proxy(target, {
    get(_target, key) {
      if (isSymbol(key) || key === "then") return undefined;

      return fake(`${path}.${key}`);
    },
    has: () => false,
    construct(_target, args) {
      current.events.push({ sdk: `new ${path}`, args: snapshot(args) });

      return fake(`new ${path}`);
    },
    apply(_target, _this, args) {
      current.events.push({ sdk: `${path}()`, args: snapshot(args) });

      return fake(`${path}()`);
    },
  });

  recorders.add(proxy);

  return proxy;
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Record<string, string> {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);

  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);

  return Object.fromEntries(
    [...headers]
      .map(([name, value]): [string, string] => [
        name.toLowerCase(),
        name.toLowerCase() === "user-agent" ? userAgent(value) : label(value),
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * A user agent without what differs between machines and releases: this package's version, and
 * the runtime and calling agent a provider SDK appends. The product names stay.
 */
function userAgent(value: string): string {
  return value
    .replace(/^sandbox-sdk\/\S+/, "sandbox-sdk/<version>")
    .replace(/ agent\/\S+/, "")
    .replace(/ \([^)]*\)$/, " (<runtime>)");
}

globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    current.events.push({ fetch: method, url: label(url), headers: headersOf(input, init) });

    return Response.json(
      { code: 404, error: "not_found", message: "not found", statusCode: 404 },
      { status: 404, headers: { "content-type": "application/json" } },
    );
  },
  { preconnect: () => {} },
);

/** Replaces a socket opener: a client that opens its own sockets would leave the machine. */
function refuse(name: string) {
  return (...args: JsonValue[]) => {
    current.events.push({ escape: name, args: snapshot(args) });
    throw new Error(`request-matrix: ${name} is disabled`);
  };
}

Object.assign(net, {
  connect: refuse("net.connect"),
  createConnection: refuse("net.createConnection"),
});

Object.assign(tls, { connect: refuse("tls.connect") });

const variables = [
  "BASETEN_API_KEY",
  "BOAT_API_KEY",
  "BOAT_API_BASE",
  "BOXD_API_KEY",
  "BOXD_BASE_URL",
  "BOXD_API_URL",
  "DAYTONA_API_KEY",
  "DAYTONA_JWT_TOKEN",
  "DAYTONA_ORGANIZATION_ID",
  "DAYTONA_API_URL",
  "DAYTONA_SERVER_URL",
  "DAYTONA_TARGET",
  "E2B_API_KEY",
  "E2B_API_URL",
  "E2B_SANDBOX_URL",
  "E2B_DEBUG",
  "E2B_DOMAIN",
  "FREESTYLE_API_KEY",
  "INSTABOX_API_KEY",
  "INSTABOX_API_URL",
  "SANDBOXER_API_KEY",
  "SANDBOXER_REGION",
  "SUPERSERVE_API_KEY",
  "SUPERSERVE_BASE_URL",
  "TENKI_API_KEY",
  "TENKI_AUTH_TOKEN",
  "TENKI_API_ENDPOINT",
  "TENKI_API_URL",
  "UPSTASH_BOX_API_KEY",
  "UPSTASH_BOX_BASE_URL",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_OIDC_TOKEN",
];

interface Case {
  readonly provider: string;
  readonly name: string;
  readonly env: Readonly<Record<string, string>>;
  readonly options: Options;
}

const conflicting = "https://env.invalid/api//";

/** Each provider: credentials from the environment only, a custom endpoint, explicit options that conflict with the environment, and the provider's own variants. */
const cases: Case[] = [
  { provider: "baseten", name: "env", env: { BASETEN_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "baseten",
    name: "options over env",
    env: { BASETEN_API_KEY: secrets.envKey },
    options: { apiKey: secrets.optionKey, teamId: "team-option" },
  },
  { provider: "baseten", name: "no key", env: {}, options: {} },
  { provider: "boat", name: "env", env: { BOAT_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "boat",
    name: "env base with slashes",
    env: { BOAT_API_KEY: secrets.envKey, BOAT_API_BASE: "https://boat.invalid/api/v1//" },
    options: {},
  },
  {
    provider: "boat",
    name: "options over env",
    env: { BOAT_API_KEY: secrets.envKey, BOAT_API_BASE: conflicting },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/v1//" },
  },
  {
    provider: "boat",
    name: "apiUrl alias",
    env: { BOAT_API_KEY: secrets.envKey },
    options: { apiUrl: "https://alias.invalid/v1/" },
  },
  { provider: "boat", name: "no key", env: {}, options: {} },
  { provider: "sandboxer", name: "env", env: { SANDBOXER_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "sandboxer",
    name: "options over env",
    env: { SANDBOXER_API_KEY: secrets.envKey },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/sbx//" },
  },
  { provider: "boxd", name: "env", env: { BOXD_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "boxd",
    name: "options over env",
    env: { BOXD_API_KEY: secrets.envKey, BOXD_BASE_URL: conflicting },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/boxd/" },
  },
  {
    provider: "boxd",
    name: "baseURL alias",
    env: { BOXD_API_KEY: secrets.envKey },
    options: { baseURL: "https://alias.invalid/boxd" },
  },
  { provider: "boxd", name: "no key", env: {}, options: {} },
  { provider: "daytona", name: "env", env: { DAYTONA_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "daytona",
    name: "env URL with slashes",
    env: { DAYTONA_API_KEY: secrets.envKey, DAYTONA_API_URL: "https://daytona.invalid/live///" },
    options: {},
  },
  {
    provider: "daytona",
    name: "server URL and target",
    env: {
      DAYTONA_API_KEY: secrets.envKey,
      DAYTONA_SERVER_URL: "https://server.invalid/api/",
      DAYTONA_TARGET: "eu",
    },
    options: {},
  },
  {
    provider: "daytona",
    name: "options over env",
    env: { DAYTONA_API_KEY: secrets.envKey, DAYTONA_API_URL: conflicting, DAYTONA_TARGET: "eu" },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/api//", target: "us" },
  },
  {
    provider: "daytona",
    name: "apiUrl alias",
    env: { DAYTONA_API_KEY: secrets.envKey },
    options: { apiUrl: "https://alias.invalid/api" },
  },
  {
    provider: "daytona",
    name: "jwt",
    env: { DAYTONA_JWT_TOKEN: secrets.jwt, DAYTONA_ORGANIZATION_ID: "org-env" },
    options: {},
  },
  {
    provider: "daytona",
    name: "jwt option over env key",
    env: { DAYTONA_API_KEY: secrets.envKey, DAYTONA_ORGANIZATION_ID: "org-env" },
    options: { jwtToken: secrets.jwt, organizationId: "org-option" },
  },
  {
    provider: "daytona",
    name: "jwt without org",
    env: { DAYTONA_JWT_TOKEN: secrets.jwt },
    options: {},
  },
  { provider: "daytona", name: "no key", env: {}, options: {} },
  { provider: "e2b", name: "env", env: { E2B_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "e2b",
    name: "env domain",
    env: { E2B_API_KEY: secrets.envKey, E2B_DOMAIN: "domain.invalid" },
    options: {},
  },
  {
    provider: "e2b",
    name: "env API URL with slash",
    env: { E2B_API_KEY: secrets.envKey, E2B_API_URL: "https://api.e2b.invalid/" },
    options: {},
  },
  {
    provider: "e2b",
    name: "debug",
    env: { E2B_API_KEY: secrets.envKey, E2B_DEBUG: "true", E2B_DOMAIN: "remote.invalid" },
    options: {},
  },
  {
    provider: "e2b",
    name: "options over env",
    env: { E2B_API_KEY: secrets.envKey, E2B_DOMAIN: "env.invalid" },
    options: { apiKey: secrets.optionKey, domain: "option.invalid" },
  },
  { provider: "e2b", name: "no key", env: {}, options: {} },
  { provider: "freestyle", name: "env", env: { FREESTYLE_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "freestyle",
    name: "options over env",
    env: { FREESTYLE_API_KEY: secrets.envKey },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/fs//" },
  },
  { provider: "freestyle", name: "no key", env: {}, options: {} },
  { provider: "instabox", name: "env", env: { INSTABOX_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "instabox",
    name: "env URL with slashes",
    env: { INSTABOX_API_KEY: secrets.envKey, INSTABOX_API_URL: "https://instabox.invalid//" },
    options: {},
  },
  {
    provider: "instabox",
    name: "options over env",
    env: { INSTABOX_API_KEY: secrets.envKey, INSTABOX_API_URL: conflicting },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/ib/" },
  },
  {
    provider: "superserve",
    name: "env",
    env: { SUPERSERVE_API_KEY: secrets.envKey },
    options: {},
  },
  {
    provider: "superserve",
    name: "region key",
    env: { SUPERSERVE_API_KEY: secrets.superserveUsw },
    options: {},
  },
  {
    provider: "superserve",
    name: "env base with slashes",
    env: { SUPERSERVE_API_KEY: secrets.envKey, SUPERSERVE_BASE_URL: "https://ss.invalid//" },
    options: {},
  },
  {
    provider: "superserve",
    name: "options over env",
    env: { SUPERSERVE_API_KEY: secrets.superserveUsw, SUPERSERVE_BASE_URL: conflicting },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/ss/" },
  },
  {
    provider: "superserve",
    name: "blank base option",
    env: { SUPERSERVE_API_KEY: secrets.superserveUsw },
    options: { baseUrl: "  " },
  },
  { provider: "tenki", name: "env key", env: { TENKI_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "tenki",
    name: "auth token wins",
    env: { TENKI_API_KEY: secrets.envKey, TENKI_AUTH_TOKEN: secrets.envToken },
    options: {},
  },
  {
    provider: "tenki",
    name: "options over env",
    env: { TENKI_API_KEY: secrets.envKey, TENKI_API_ENDPOINT: conflicting },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/tenki" },
  },
  {
    provider: "tenki",
    name: "authToken option",
    env: { TENKI_AUTH_TOKEN: secrets.envToken },
    options: { authToken: secrets.optionToken },
  },
  { provider: "tenki", name: "no key", env: {}, options: {} },
  { provider: "upstash", name: "env", env: { UPSTASH_BOX_API_KEY: secrets.envKey }, options: {} },
  {
    provider: "upstash",
    name: "env URL with slashes",
    env: { UPSTASH_BOX_API_KEY: secrets.envKey, UPSTASH_BOX_BASE_URL: "https://box.invalid//" },
    options: {},
  },
  {
    provider: "upstash",
    name: "options over env",
    env: { UPSTASH_BOX_API_KEY: secrets.envKey, UPSTASH_BOX_BASE_URL: conflicting },
    options: { apiKey: secrets.optionKey, baseUrl: "https://option.invalid/tenant//" },
  },
  {
    provider: "upstash",
    name: "ephemeral",
    env: { UPSTASH_BOX_API_KEY: secrets.envKey },
    options: { ephemeral: true, baseUrl: "https://option.invalid/eph/" },
  },
  { provider: "upstash", name: "no key", env: {}, options: {} },
  {
    provider: "vercel",
    name: "env token",
    env: {
      VERCEL_TOKEN: secrets.envToken,
      VERCEL_TEAM_ID: "team_env",
      VERCEL_PROJECT_ID: "prj_env",
    },
    options: {},
  },
  {
    provider: "vercel",
    name: "options over env",
    env: {
      VERCEL_TOKEN: secrets.envToken,
      VERCEL_TEAM_ID: "team_env",
      VERCEL_PROJECT_ID: "prj_env",
    },
    options: { token: secrets.optionToken, teamId: "team_option", projectId: "prj_option" },
  },
  {
    provider: "vercel",
    name: "token without team",
    env: { VERCEL_TOKEN: secrets.envToken },
    options: {},
  },
  { provider: "vercel", name: "no credentials", env: {}, options: {} },
];

const at = (path: string) => pathToFileURL(join(source, path)).href;

/** Factory options: the adapters' own option names, with string or boolean values. */
type Options = Readonly<Record<string, string | boolean>>;

/** `provider.api` or `box.native` on adapters that bind their provider's SDK. */
interface SdkBinding {
  sdk(load: () => Promise<object>): Promise<object>;
}

/** What the matrix calls on an adapter. */
interface Adapter {
  list(labels: Readonly<Record<string, string>>): Promise<object>;
  connect(id: string): Promise<object>;
  destroy(id: string): Promise<void>;
  native(id: string): Partial<SdkBinding>;
  readonly api?: Partial<SdkBinding>;
}

function isFactory(value: unknown): value is (options: Options) => Partial<Adapter> {
  return typeof value === "function";
}

function isCode(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

type Factory = (options: Options) => Adapter;

/** The adapter a factory made, once it has every member the matrix calls. */
function adapterOf(made: Partial<Adapter>): Adapter {
  const { list, connect, destroy, native, api } = made;

  if (!list || !connect || !destroy || !native) throw new Error("Not an adapter");

  return {
    list: list.bind(made),
    connect: connect.bind(made),
    destroy: destroy.bind(made),
    native: native.bind(made),
    api,
  };
}

/** The adapter under test, with its provider SDK replaced by a recording fake where it loads one. */
async function factory(provider: string): Promise<Factory> {
  const fakeModule = async () => fake(provider);

  switch (provider) {
    case "baseten": {
      const { createBasetenProvider } = await import(at("providers/baseten/provider.ts"));

      return (options) => adapterOf(createBasetenProvider(options, fakeModule));
    }

    case "boxd": {
      const { createBoxdProvider } = await import(at("providers/boxd/provider.ts"));

      return (options) =>
        adapterOf(
          createBoxdProvider(options, fakeModule, (config: Options) => {
            current.events.push({ sdk: "boxd transfers", args: snapshot([config]) });

            return fake("boxd transfers");
          }),
        );
    }

    case "tenki": {
      const { createTenkiProvider } = await import(at("providers/tenki/provider.ts"));

      return (options) => adapterOf(createTenkiProvider(options, fakeModule));
    }

    case "upstash": {
      const { createUpstashProvider } = await import(at("providers/upstash/provider.ts"));

      return (options) => adapterOf(createUpstashProvider(options, fakeModule));
    }

    default: {
      const module: object = await import(at(`providers/${provider}/index.ts`));
      const make = Object.entries(module).find(([name]) => name === provider)?.[1];

      if (!isFactory(make)) throw new Error(`${provider} has no factory`);

      return (options) => adapterOf(make(options));
    }
  }
}

function errorOf(cause: unknown): JsonValue {
  if (!(cause instanceof Error)) return { thrown: label(String(cause)) };

  const code = "code" in cause && isCode(cause.code) ? cause.code : null;

  return { name: cause.name, code, message: label(cause.message) };
}

/** One step, bounded: a step that never settles is recorded as such. */
async function step(name: string, run: () => Promise<object | void>): Promise<void> {
  current.events.push({ step: name });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const settled = await Promise.race([
      run().then(() => "ok"),
      new Promise<string>((done) => {
        timer = setTimeout(() => done("<timeout>"), 3000);
      }),
    ]);

    current.events.push({ result: settled });
  } catch (error) {
    current.events.push({ error: errorOf(error) });
  } finally {
    clearTimeout(timer);
  }
}

const loadFake = async () => fake("sdk");
const id = "sbx-fixture";
const results: Record<string, Recording> = {};

for (const entry of cases) {
  for (const key of variables) delete process.env[key];

  Object.assign(process.env, entry.env);
  current = { events: [] };
  results[`${entry.provider}: ${entry.name}`] = current;

  try {
    const make = await factory(entry.provider);
    const adapter = make({ ...entry.options });
    const { api } = adapter;

    await step("list", () => adapter.list({ "sandbox-sdk": "1" }));
    await step("connect", () => adapter.connect(id));
    await step("destroy", () => adapter.destroy(id));
    await step("api.sdk", async () => api?.sdk?.(loadFake));
    await step("native.sdk", async () => adapter.native(id).sdk?.(loadFake));
  } catch (error) {
    current.events.push({ error: errorOf(error) });
  }
}

// Exit once the recording is flushed: a pipe takes it in chunks, and an adapter's timers would
// otherwise keep the process alive.
process.stdout.write(JSON.stringify(results, null, 1) + "\n", () => process.exit(0));

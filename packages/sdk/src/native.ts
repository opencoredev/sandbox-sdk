import type { JsonValue } from "./shared/json.js";
import { isObject, isString } from "./shared/narrow.js";
import { SandboxError, invalid, nativeDetail } from "./errors.js";
import type { HttpClient } from "./http.js";
import { peerModule } from "./peer.js";

/** An HTTP method `box.native.request` and `box.native.fetch` accept. */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Options for one raw call through {@link NativeApi}. */
export interface NativeRequestOptions<Plane extends string = string> {
  /**
   * Which of the provider's APIs to call, such as Daytona's `"api"` or `"toolbox"`. Each provider page lists
   * its planes. Default: the provider's control plane.
   */
  plane?: Plane;
  /**
   * Values for `{name}` placeholders in the path, URI-encoded. Only the provider's own sandbox placeholder
   * (such as `{sandboxId}`) fills itself on `box.native`; every other placeholder must be here, or the call
   * fails with `invalid_argument` before any request. A value here wins over the automatic one.
   */
  params?: Record<string, string | number>;
  /** Query string values. `undefined` values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * The request body. A `string`, `Uint8Array`, `ArrayBuffer`, `Blob`, `FormData`, `URLSearchParams` or
   * `ReadableStream` is sent as it is; anything else is sent as JSON.
   */
  body?: unknown;
  /** Extra request headers. They win over the SDK's own headers, except that credentials never leave the provider's origin. */
  headers?: Record<string, string>;
  /** Abort the call. It rejects with a `SandboxError` whose code is `aborted`. */
  signal?: AbortSignal;
  /**
   * Give up after this many milliseconds. `request` counts the whole call, including the response body;
   * `fetch` counts until the response headers arrive. Default: the provider's request timeout.
   */
  timeoutMs?: number;
}

/**
 * The widest type of `sdk` on a {@link NativeApi}: it takes a function that imports the provider's official
 * SDK and resolves to that SDK's object for this sandbox. Each provider narrows it with a structural
 * constraint on the module, so the result type comes from the module you imported, not from this package:
 *
 * ```ts
 * type DaytonaSdk = <M extends { Daytona: new (config: object) => { get(id: string): Promise<unknown> } }>(
 *   load: () => Promise<M>) => Promise<Awaited<ReturnType<InstanceType<M["Daytona"]>["get"]>>>;
 * ```
 *
 * Every provider's `sdk` is assignable to this one, so a plain `NativeApi` accepts any provider's native API.
 * Through a plain `NativeApi` the module is unknown, so `sdk` cannot be called; use the provider's own type.
 */
export type NativeSdkLoader = (load: () => Promise<never>) => Promise<object>;

/** The `sdk` loader of a provider that does not describe its module: any module in, `unknown` out. */
export type AnyNativeSdk = <M extends object>(load: () => Promise<M>) => Promise<object>;

/**
 * Direct access to a provider's HTTP API, with the adapter's base URLs, credentials, retries, error mapping
 * and redaction. On a sandbox it is `box.native`; on a provider factory it is `provider.api`, with no
 * sandbox bound.
 *
 * ```ts
 * const box = await createSandbox(daytona());
 * const files = await box.native.request<{ name: string }[]>("GET", "/files", { plane: "toolbox", query: { path: "/workspace" } });
 * const sdkSandbox = await box.native.sdk(() => import("@daytonaio/sdk"));
 * ```
 */
export interface NativeApi<
  Plane extends string = string,
  Sdk extends NativeSdkLoader = NativeSdkLoader,
> {
  /** The sandbox this client is bound to. `undefined` on `provider.api`. */
  readonly sandboxId?: string;
  /**
   * Call an endpoint and return its JSON body, or `undefined` for an empty body (such as a 204). `T` is
   * not checked at runtime. A non-2xx response rejects with a `SandboxError`. A `GET`, `HEAD`, `PUT` or
   * `DELETE` is retried on 429, 502, 503, 504 and network errors; other methods are never retried.
   */
  request<T = unknown>(
    method: HttpMethod,
    path: string,
    options?: NativeRequestOptions<Plane>,
  ): Promise<T>;
  /**
   * Call an endpoint and return the raw `Response`, for bytes and streams. A non-2xx response still
   * rejects with a `SandboxError`. You own the body: read it or call `response.body?.cancel()`.
   */
  fetch(method: HttpMethod, path: string, options?: NativeRequestOptions<Plane>): Promise<Response>;
  /**
   * Hand over the provider's official SDK module, imported by you, and get its object for this sandbox
   * (or its client on `provider.api`): `await box.native.sdk(() => import("@daytonaio/sdk"))`. The SDK is
   * not a dependency of this package; install it yourself to use this. Rejects with `unavailable` when the
   * import fails and `invalid_argument` when the module does not have the expected exports.
   */
  readonly sdk: Sdk;
}

/** How an adapter turns the caller's SDK module into the object `sdk()` returns. */
export interface NativeSdkBinding {
  /** The npm package, for messages: `"@daytonaio/sdk"`. */
  readonly package: string;
  /**
   * Build the SDK object for `sandboxId`, or the account client when it is undefined. `module` is untrusted:
   * use it through {@link sdkConstruct} and {@link sdkCall}, which throw `invalid_argument` when an export or method is missing.
   */
  connect(module: SdkValue, sandboxId: string | undefined): object | Promise<object>;
}

/** A member of the caller's SDK module, or of an object it built, read by name and checked before use. */
export type SdkMember = SdkValue | JsonValue | undefined;

/** A module, class, function or object from the caller's SDK. */
export interface SdkValue {
  readonly [member: string]: SdkMember;
}

/** Whether a member is an object or function that can have members of its own. */
function isSdkValue(value: SdkMember): value is SdkValue {
  return value instanceof Function || (isObject(value) && !Array.isArray(value));
}

/** `value` when the SDK returned an object, else `invalid_argument` naming the package. */
export function sdkObject(value: SdkMember, what: string, packageName: string): SdkValue {
  if (!isSdkValue(value))
    invalid(
      `${what} from ${packageName} is not an object. Install a supported version of ${packageName}`,
    );

  return value;
}

/** Options for {@link createNativeApi}. */
export interface NativeApiOptions<Plane extends string> {
  /** The adapter's HTTP client. Its planes, credentials, retries, redaction and error hooks apply to native calls too. */
  http: HttpClient<Plane>;
  /** The placeholder(s) `box.native` fills from the sandbox ID, without braces: `"sandboxId"`, or several names when the provider's docs use more than one. */
  placeholder: string | readonly string[];
  /** Bind to this sandbox (`box.native`). Leave it out for `provider.api`. */
  sandboxId?: string;
  /** How `sdk(load)` connects. Without it, `sdk()` rejects with `unsupported`. */
  sdk?: NativeSdkBinding;
}

const methods: ReadonlySet<string> = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/**
 * Builds `box.native` (with `sandboxId`) or `provider.api` (without) on top of an adapter's HTTP client.
 * `Sdk` is the provider's loader type; the runtime binding checks the module's shape.
 */
export function createNativeApi<Plane extends string, Sdk extends NativeSdkLoader = AnyNativeSdk>(
  options: NativeApiOptions<Plane>,
): NativeApi<Plane, Sdk> {
  const { http, placeholder, sandboxId, sdk: binding } = options;
  const names: readonly string[] = isString(placeholder) ? [placeholder] : placeholder;

  function call(method: HttpMethod, path: string, request: NativeRequestOptions<Plane> = {}) {
    if (!isString(method) || !methods.has(method))
      invalid(`Unsupported HTTP method ${String(method).slice(0, 16)}`);

    if (!isString(path)) invalid("The path must be a string");

    const filled = names.filter(
      (name) => path.includes(`{${name}}`) && request.params?.[name] === undefined,
    );

    const params =
      sandboxId === undefined || filled.length === 0
        ? request.params
        : { ...request.params, ...Object.fromEntries(filled.map((name) => [name, sandboxId])) };

    return {
      method,
      path,
      plane: request.plane,
      sandboxId,
      params,
      query: request.query,
      body: request.body,
      headers: request.headers,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      detail: "message" as const,
    };
  }

  async function connect(load: () => Promise<object>): Promise<object> {
    if (!binding)
      throw new SandboxError(
        `${http.label} has no official SDK binding. Use native.request or native.fetch.`,
        { code: "unsupported", provider: http.provider, sandboxId },
      );

    if (!(load instanceof Function))
      invalid(
        `Pass a function that imports the SDK: native.sdk(() => import("${binding.package}"))`,
      );
    let module: SdkMember;

    try {
      // SAFETY: a module namespace or CommonJS exports object, or whatever the caller returned; it is
      // checked below, and adapters read each export through sdkConstruct and sdkCall.
      module = peerModule(await load()) as SdkMember;
    } catch (error) {
      const missing =
        error instanceof Error &&
        (("code" in error &&
          (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND")) ||
          /Cannot find (?:package|module)/.test(error.message));

      if (missing)
        throw new SandboxError(
          `${binding.package} could not be imported. Install it next to @opencoredev/sandbox-sdk to use native.sdk().`,
          {
            code: "unavailable",
            provider: http.provider,
            sandboxId,
            hint: `npm i ${binding.package}`,
            cause: nativeDetail(error, http.redact),
          },
        );
      throw new SandboxError(
        `Loading ${binding.package} failed: ${nativeDetail(error, http.redact) ?? "a non-Error value was thrown"}. Check the import passed to native.sdk().`,
        { code: "provider", provider: http.provider, sandboxId },
      );
    }

    if (!isSdkValue(module) || Array.isArray(module))
      invalid(`native.sdk() needs the module object. Pass () => import("${binding.package}")`);

    try {
      return await binding.connect(module, sandboxId);
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      // The caller's SDK threw. Its text is the only clue; keep it scrubbed and redacted, as for any unrecognized failure.
      throw new SandboxError(
        `${binding.package} failed in native.sdk(): ${nativeDetail(error, http.redact) ?? "a non-Error value was thrown"}. Check the SDK version and the sandbox.`,
        {
          code: "provider",
          provider: http.provider,
          sandboxId,
          cause: nativeDetail(error, http.redact),
        },
      );
    }
  }

  // `Sdk` is the adapter's narrowed signature for this one runtime function; its result type is derived from
  // the caller's module type, which no runtime check can produce, so this is the single place it is asserted.
  // SAFETY: connect implements every overload of Sdk; TypeScript cannot check overloads against one function.
  const loader: NativeSdkLoader = connect;
  // SAFETY: the same function; Sdk only narrows the module and result types for the caller.
  const sdk = loader as Sdk;

  return {
    sandboxId,
    async request<T = unknown>(
      method: HttpMethod,
      path: string,
      request?: NativeRequestOptions<Plane>,
    ): Promise<T> {
      // `T` is the caller's claim about the body, as with `Response.json()`; it is documented as unchecked.
      // SAFETY: T is the caller's declared response shape; request<T> documents that the body is not validated.
      return (await http.json(call(method, path, request))) as T;
    },
    fetch(method, path, request) {
      return http.stream(call(method, path, request));
    },
    sdk,
  };
}

/**
 * `new module[name](...args)` for a module handed to `native.sdk()`. Throws `invalid_argument` naming
 * the package when the export is missing or is not a class.
 */
export function sdkConstruct(
  module: SdkValue,
  name: string,
  args: unknown[],
  packageName: string,
): SdkValue {
  const value = module[name];

  if (!(value instanceof Function))
    invalid(
      `The module passed to native.sdk() has no ${name} export. Pass () => import("${packageName}")`,
    );

  try {
    return sdkObject(Reflect.construct(value, args), name, packageName);
  } catch (error) {
    if (error instanceof TypeError && /constructor/i.test(error.message))
      invalid(
        `${name} from the module passed to native.sdk() is not a class. Pass () => import("${packageName}")`,
      );
    throw error;
  }
}

/**
 * `target[name](...args)` on an object from the caller's SDK, awaited. Throws `invalid_argument` naming
 * the package when the method is missing, which means the installed SDK version does not match.
 */
export async function sdkCall(
  target: SdkMember,
  name: string,
  args: unknown[],
  packageName: string,
): Promise<SdkMember> {
  const method = isSdkValue(target) ? target[name] : undefined;

  if (!(method instanceof Function))
    invalid(
      `The ${packageName} object has no ${name} method. Install a supported version of ${packageName}`,
    );

  const result: SdkMember = await method.apply(target, args);

  return result;
}

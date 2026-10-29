import { z } from "zod";

/**
 * Typed access to native provider SDKs. They are optional peers loaded at runtime, so the bench
 * cannot import their types; every value read from one goes through a schema here.
 */

/** A value read from a native SDK: a primitive, or another native object. */
type NativeValue = string | number | boolean | bigint | symbol | null | undefined | Native;

/** An object, class or function from a native SDK, read member by member. */
export interface Native {
  readonly [member: string]: NativeValue;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** An argument passed to a native SDK method or constructor. */
export type NativeArgument =
  | string
  | number
  | boolean
  | undefined
  | readonly string[]
  | Fetch
  | Native
  | { readonly [option: string]: NativeArgument };

type NativeMethod = (this: Native, ...args: NativeArgument[]) => NativeValue | Promise<NativeValue>;

/** A native class, or the error class a native SDK throws. */
export type NativeClass = new (options?: NativeArgument) => Native;

function isNative(value: unknown): value is Native {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isNativeMethod(value: unknown): value is NativeMethod {
  return typeof value === "function";
}

function isNativeClass(value: unknown): value is NativeClass {
  return typeof value === "function";
}

export const nativeSchema = z.custom<Native>(isNative, "Invalid native client");

export const nativeClass = z.custom<NativeClass>(isNativeClass, "Invalid native class");

/** A class export that may be absent; matching against it never throws. */
export const optionalNativeClass = nativeClass.optional().catch(undefined);

const nativeMethod = z.custom<NativeMethod>(isNativeMethod, "Invalid native method");

/** Read `key` from a native value and parse it. A missing member reads as `undefined`. */
export function member<T>(target: Native, key: string, schema: z.ZodType<T>): T {
  return schema.parse(target[key]);
}

/** Call the method `key` on `target`, keeping `target` as its receiver, and parse the result. */
export async function call<T>(
  target: Native,
  key: string,
  args: NativeArgument[],
  schema: z.ZodType<T>,
): Promise<T> {
  const method = member(target, key, nativeMethod);

  return schema.parse(await method.apply(target, args));
}

/** Construct the class exported as `key` from a native module. */
export function construct(module: Native, key: string, options?: NativeArgument): Native {
  const NativeClass = member(module, key, nativeClass);

  return new NativeClass(options);
}

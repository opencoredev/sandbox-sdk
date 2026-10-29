/** Field guards for parsing JSON and other untyped input at a boundary. Each one checks
 * exactly the shape its predicate claims, so a parser can read the field afterwards.
 * `hasString` and `hasNumber` read own properties only, which is all parsed JSON has.
 * Primitive guards live in `shared/narrow.ts`. */

import { isObject } from "../shared/narrow.js";

/** Whether the value is an object whose own `key` holds a string. */
export function hasString<K extends string>(value: unknown, key: K): value is { [P in K]: string } {
  return isObject(value) && typeof Object.getOwnPropertyDescriptor(value, key)?.value === "string";
}

/** Whether the value is an object whose own `key` holds a number. */
export function hasNumber<K extends string>(value: unknown, key: K): value is { [P in K]: number } {
  return isObject(value) && typeof Object.getOwnPropertyDescriptor(value, key)?.value === "number";
}

/** Whether the value is callable, such as a class an `instanceof` check can use. */
export function isFunction(value: unknown): value is (...args: never[]) => void {
  return typeof value === "function";
}

/** Whether `value[key]` is callable, read the way property access reads it: inherited
 * properties and getters count, as in a bundler's module namespace. TypeScript cannot
 * index `object` with a generic key, so this walks the prototype chain itself. */
export function hasFunction<K extends string>(
  value: unknown,
  key: K,
): value is { [P in K]: (...args: never[]) => void } {
  for (let owner: unknown = value; isObject(owner); owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);

    if (descriptor)
      return isFunction(descriptor.get ? descriptor.get.call(value) : descriptor.value);
  }

  return false;
}

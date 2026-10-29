/** Field guards for parsing JSON at a boundary. Each one checks exactly the field its predicate
 * claims, so a parser can read the field afterwards. They read own properties only, which is all
 * parsed JSON has. Primitive guards live in `shared/narrow.ts`. */

import { isObject } from "../shared/narrow.js";

/** Whether the value is an object whose own `key` holds a string. */
export function hasString<K extends string>(value: unknown, key: K): value is { [P in K]: string } {
  return isObject(value) && typeof Object.getOwnPropertyDescriptor(value, key)?.value === "string";
}

/** Whether the value is an object whose own `key` holds a number. */
export function hasNumber<K extends string>(value: unknown, key: K): value is { [P in K]: number } {
  return isObject(value) && typeof Object.getOwnPropertyDescriptor(value, key)?.value === "number";
}

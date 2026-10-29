/** Field guards for parsing JSON and other untyped input at a boundary. Each one checks
 * exactly the shape its predicate claims, so a parser can read the field afterwards.
 * They read own properties only, which is all parsed JSON has. */

/** Whether the value is a non-null object (arrays included). */
export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Whether the value is an object whose own `key` holds a string. */
export function hasString<K extends string>(value: unknown, key: K): value is { [P in K]: string } {
  return isObject(value) && typeof Object.getOwnPropertyDescriptor(value, key)?.value === "string";
}

/** Whether the value is an object whose own `key` holds a number. */
export function hasNumber<K extends string>(value: unknown, key: K): value is { [P in K]: number } {
  return isObject(value) && typeof Object.getOwnPropertyDescriptor(value, key)?.value === "number";
}

/** Whether the value is a string. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

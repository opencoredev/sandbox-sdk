/** Type guards for decoded guest JSON and native SDK errors. */

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** A non-null object, so `"key" in value` narrows its properties. */
export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** A JSON object whose values are all strings, such as SDK labels. */
export function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && !Array.isArray(value) && Object.values(value).every(isString);
}

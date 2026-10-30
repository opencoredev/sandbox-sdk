// Type guards for decoded E2B JSON. Kept in the adapter so it depends on nothing but `/provider`.
import type { JsonObject, JsonValue } from "../../provider.js";

export const isString = (value: unknown): value is string => typeof value === "string";

export const isNumber = (value: unknown): value is number => typeof value === "number";

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** A non-null object, so `"key" in value` narrows its properties. */
export const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

export const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

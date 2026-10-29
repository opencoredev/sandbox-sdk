import { isObject } from "./narrow.js";

/** A value JSON can carry: the raw tool arguments an AI framework passes on from the model,
 * before the tool's schema parses them, or the output of `JSON.parse`. An `undefined` member
 * is an absent key.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/** A JSON object. Read a member, then check its type. */
export type JsonObject = { [key: string]: JsonValue | undefined };

/** Whether a JSON value is an object rather than an array or a primitive. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isObject(value) && !Array.isArray(value);
}

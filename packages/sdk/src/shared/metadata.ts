/** Decodes the SDK metadata an adapter stores with a sandbox: the caller's key and labels. */
import type { Labels } from "../provider.js";
import type { JsonValue } from "./json.js";
import { isNumber, isObject, isString } from "./narrow.js";

/** SDK metadata as an adapter stored it. Each adapter checks the fields its own format requires. */
export interface StoredMetadata {
  /** `null` when stored as null, `undefined` when the record has no key. */
  key: string | null | undefined;
  labels: Labels;
  /** The format version, for adapters that store one. */
  version: number | undefined;
  /** Creation time in epoch milliseconds, for adapters that store one. */
  createdAt: number | undefined;
}

/** The part of stored metadata that failed to decode. */
export type MetadataPart = "metadata" | "label";

/** Labels as stored: a JSON object whose values are all strings. Undefined for anything else. */
export function decodeLabels(value: JsonValue | undefined): Labels | undefined {
  if (!isObject(value) || Array.isArray(value)) return undefined;
  const labels: Labels = {};

  for (const [key, label] of Object.entries(value)) {
    if (!isString(label)) return undefined;
    // defineProperty, so a "__proto__" label stays an ordinary label.
    Object.defineProperty(labels, key, {
      value: label,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return labels;
}

/** Parses stored metadata JSON. `invalid` throws the adapter's error for the part that failed. */
export function parseMetadata(
  text: string,
  invalid: (part: MetadataPart) => never,
): StoredMetadata {
  let value: JsonValue;

  try {
    value = JSON.parse(text);
  } catch {
    invalid("metadata");
  }

  if (
    !isObject(value) ||
    Array.isArray(value) ||
    !isObject(value.labels) ||
    Array.isArray(value.labels)
  )
    invalid("metadata");
  const { key, version, createdAt } = value;

  if (
    (key !== undefined && key !== null && !isString(key)) ||
    (version !== undefined && !isNumber(version)) ||
    (createdAt !== undefined && !isNumber(createdAt))
  )
    invalid("metadata");

  const labels = decodeLabels(value.labels) ?? invalid("label");

  return { key, labels, version, createdAt };
}

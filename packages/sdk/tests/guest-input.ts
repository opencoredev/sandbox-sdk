/** Test transports map sandbox paths into a host directory by rewriting commands. Guest file commands
 * (files.edit, files.search) carry their paths in a JSON object instead, in SANDBOX_SDK_INPUT or on
 * stdin when that variable is empty, so a transport maps those path fields and leaves user text alone. */
import { isJsonObject, type JsonValue } from "../src/shared/json.js";
import { isString } from "../src/shared/narrow.js";

export const guestInputVariable = "SANDBOX_SDK_INPUT";

/** The guest input with its `path` and `root` fields mapped; anything that is not such an object is unchanged. */
export function mapGuestInput(text: string, map: (path: string) => string): string {
  let value: JsonValue;

  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }

  if (!isJsonObject(value)) return text;
  const mapped = { ...value };

  for (const key of ["path", "root"]) {
    const field = mapped[key];

    if (isString(field)) mapped[key] = map(field);
  }

  return JSON.stringify(mapped);
}

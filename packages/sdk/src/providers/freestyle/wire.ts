import type { ExecInput } from "../../provider.js";

type Spec = Pick<ExecInput, "command" | "cwd" | "env" | "stdin" | "timeoutMs" | "activityPath"> & {
  marker?: string;
  workspace?: string;
  files?: [string, string][];
};
type Value = string | number | undefined | Value[] | { [key: string]: Value };

// CPython's primitive marshal format avoids loading the JSON/regex module tree
// on a fresh guest. Only strings, numbers, arrays and dictionaries are emitted.
export function guestSpec(spec: Spec | (Omit<Spec, "env" | "stdin"> & { envKeys: string[] })): Buffer {
  const parts: Buffer[] = [];
  function write(value: Value): void {
    if (typeof value === "string") {
      const bytes = Buffer.from(value);
      const header = Buffer.alloc(5); header[0] = 117; header.writeUInt32LE(bytes.length, 1);
      parts.push(header, bytes);
    } else if (typeof value === "number") {
      const bytes = Buffer.alloc(9); bytes[0] = 103; bytes.writeDoubleLE(value, 1); parts.push(bytes);
    } else if (Array.isArray(value)) {
      const header = Buffer.alloc(5); header[0] = 91; header.writeUInt32LE(value.length, 1); parts.push(header);
      for (const item of value) write(item);
    } else if (value !== undefined) {
      parts.push(Buffer.from("{"));
      for (const [key, item] of Object.entries(value)) if (item !== undefined) { write(key); write(item); }
      parts.push(Buffer.from("0"));
    }
  }
  write(spec);
  return Buffer.concat(parts);
}

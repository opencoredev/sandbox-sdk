import type { OutputChunk } from "./provider.js";

export function encodeChunk(chunk: OutputChunk): string[] {
  const records: string[] = [];
  const prefix = chunk.stream === "stdout" ? "O" : "E";
  const lines = chunk.text.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const complete = index < lines.length - 1;

    // Small records allow bounded pending writes and cursor reads of large lines.
    for (let offset = 0; offset < line.length;) {
      let end = Math.min(line.length, offset + 8192);
      const last = line.charCodeAt(end - 1);

      if (end < line.length && last >= 0xd800 && last <= 0xdbff) end--;

      records.push(
        (complete && end === line.length ? prefix : prefix.toLowerCase()) +
          line.slice(offset, end) +
          "\n",
      );
      offset = end;
    }

    if (!line && complete) records.push(prefix + "\n");
  }

  return records;
}

export function decodePage(bytes: Uint8Array, offset: number, max: number, base: number) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const events: (OutputChunk & { cursor: string })[] = [];

  let position = Math.min(offset, buffer.length),
    kept = 0;

  while (position < buffer.length && kept < max) {
    const start = position === 0 ? 0 : buffer.lastIndexOf(10, position - 1) + 1;
    const prefix = buffer[start];

    if (position === start) position++;
    const delimiter = buffer.indexOf(10, position);

    if (delimiter < 0) break;
    let end = Math.min(delimiter, position + max - kept);
    const continuation = (at: number) => ((buffer[at] ?? 0) & 0xc0) === 0x80;

    while (end > position && end < delimiter && continuation(end)) end--;

    if (end === position && position < delimiter) {
      if (kept) break;
      // A budget smaller than one code point must still make progress (at most 4 bytes).
      end++;

      while (end < delimiter && continuation(end)) end++;
    }

    let text = buffer.subarray(position, end).toString();
    kept += end - position;
    position = end;

    if (position === delimiter && (prefix === 79 || prefix === 69) && kept < max) {
      text += "\n";
      kept++;
      position++;
    } else if (position === delimiter && prefix !== 79 && prefix !== 69) position++;
    events.push({
      stream: prefix === 69 || prefix === 101 ? "stderr" : "stdout",
      text,
      cursor: String(base + position),
    });
  }

  return { events, offset: position };
}

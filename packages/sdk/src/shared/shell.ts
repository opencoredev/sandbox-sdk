/** Quote one value as a single POSIX shell word. Safe for any string, including quotes and newlines. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

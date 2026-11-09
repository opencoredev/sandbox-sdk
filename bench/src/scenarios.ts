/** The main suite's scenarios, in order. */
export const scenarioNames = [
  "command",
  "files-1kb",
  "files-10mb",
  "reconnect",
  "pause-resume",
  "snapshot",
  "fingerprint",
  "perf",
  "git-clone",
  "npm-install",
  "dev-server",
  "preview-first-byte",
  "edit-loop",
  "tool-replay",
  "pip-install",
];

/**
 * The longest one iteration can run: each scenario, plus create, fingerprint, restore and destroy,
 * may take up to the per-step timeout. The admission reserve and sandbox lifetimes both use it.
 */
export function iterationBoundMs(timeoutMs: number): number {
  return timeoutMs * (scenarioNames.length + 4);
}

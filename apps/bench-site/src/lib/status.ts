import { metric } from "@/lib/data";
import type { Provider } from "@/lib/data";
import { formatCount } from "@/lib/format";
import type { Cell } from "@/lib/status-look";

/** The tests on the status board, in page order. The machine tests all run in one probe, so one cell stands for them. */
export const boardTests = [
  ["cold", "Cold start"],
  ["command", "Command"],
  ["files-1kb", "1 KB file"],
  ["files-10mb", "10 MB file"],
  ["reconnect", "Reconnect"],
  ["pause-resume", "Pause"],
  ["destroy", "Destroy"],
  ["snapshot", "Snapshot"],
  ["create-from-snapshot", "From snapshot"],
  ["git-clone", "git clone"],
  ["npm-install", "npm install"],
  ["pip-install", "pip install"],
  ["dev-server", "Dev server"],
  ["preview-first-byte", "Preview URL"],
  ["edit-loop", "Edit loop"],
  ["tool-replay", "Tool replay"],
  ["cpu-single", "Machine tests"],
  ["burst-10", "10 at once"],
  ["burst-25", "25 at once"],
] as const;

/** One provider's result on one test: how many attempts succeeded, and what kind of failures the rest were. */
export function cellFor(provider: Provider, [id, name]: (typeof boardTests)[number]): Cell {
  const v = metric(id).values.find((x) => x.provider === provider.id);
  const attempts = v ? v.n + v.failures : 0;
  const base = { id, name, succeeded: v?.n ?? 0, attempts };
  if (!v || attempts === 0) return { ...base, state: "none", text: "not supported or not run" };
  const own = v.failures - v.limitFailures;
  const text = `${formatCount(v.n)} of ${formatCount(attempts)} succeeded`;
  if (v.failures === 0) return { ...base, state: "ok", text };
  if (own === 0) return { ...base, state: "limit", text: `${text}; the rest hit our plan's limit` };
  return { ...base, state: own / attempts < 0.05 ? "some" : "many", text };
}

/** Plain success rate over the tests on the board: every attempt counts, whatever made it fail. */
export function successRate(provider: Provider) {
  const cells = boardTests.map((t) => cellFor(provider, t));
  const attempts = cells.reduce((sum, c) => sum + c.attempts, 0);
  const succeeded = cells.reduce((sum, c) => sum + c.succeeded, 0);
  return { attempts, succeeded, rate: attempts ? succeeded / attempts : null };
}

import { setTimeout as sleep } from "node:timers/promises";
import type { Session } from "@tenkicloud/sandbox";
import { SandboxError } from "../../errors.js";
import { deadline } from "./deadline.js";
import { failure, tenkiError } from "./errors.js";

/** SDK 1.4.1 waits for stream EOF even after RUNNING, and does not recover a
 * silent stream. Reserve the rest of the original budget for bounded refreshes.
 * Successful streams keep their existing path and make no additional RPCs.
 */
export async function waitReady(
  value: Session,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  const running = () => value.state === "RUNNING";
  if (signal?.aborted) throw failure("Creation aborted", "aborted");
  // Match native create(): a running allocation with route credentials needs
  // no control-plane readiness stream before its first data-plane operation.
  if (running() && typeof value.dataPlaneRPC === "function" && value.dataPlaneRPC()) return;
  try {
    await deadline(
      (signal) => value.waitReady(timeoutMs, signal),
      Math.min(5000, timeoutMs / 2),
      signal,
    );
    return;
  } catch (error) {
    if (signal?.aborted) throw failure("Creation aborted", "aborted");
    if (tenkiError(error).code !== "timeout") throw error;
  }
  // The stream may already have delivered RUNNING plus route credentials, but
  // failed to close. Its parsed state is sufficient; do not add a polling RPC.
  if (running()) return;
  let lastError: unknown;
  while (Date.now() < end) {
    if (signal?.aborted) throw failure("Creation aborted", "aborted");
    try {
      await deadline(() => value.refresh(), Math.min(10_000, end - Date.now()), signal);
      if (signal?.aborted) throw failure("Creation aborted", "aborted");
      if (running()) return;
      if (["TERMINATED", "TERMINATING"].includes(value.state))
        throw failure("Session terminated before readiness", "not_found");
    } catch (error) {
      const code = tenkiError(error).code;
      if (["auth", "not_found", "invalid_argument", "aborted"].includes(code)) throw error;
      lastError = error;
    }
    const remaining = end - Date.now();
    if (remaining > 0) {
      try {
        await sleep(Math.min(1000, remaining), undefined, { signal });
      } catch {
        throw failure("Creation aborted", "aborted");
      }
    }
  }
  // The create boundary sanitizes this native error before exposing it. Keep
  // it until then so polling transport failures do not disappear as timeouts.
  throw new SandboxError("Tenki session did not become ready within its readiness budget.", {
    code: "timeout",
    provider: "tenki",
    sandboxId: value.id,
    cause: lastError,
  });
}

export const workspaceSetup = `workspace=globals().get('v',{}).get('workspace','/workspace')
home=os.path.join(os.path.dirname(workspace),'home','tenki')
tmp=os.path.join(os.path.dirname(workspace),'tmp')
os.makedirs(home+'/.sandbox-sdk',exist_ok=True)
os.makedirs(tmp,exist_ok=True)
if not os.path.exists(home+'/.sandbox-sdk/prepared'):
 if not os.path.exists(workspace):
  os.makedirs(home+'/workspace',exist_ok=True)
  try: os.symlink(home+'/workspace',workspace)
  except FileExistsError: pass
 elif not os.path.islink(workspace) and not os.path.exists(home+'/workspace'):
  os.rename(workspace,home+'/workspace'); os.symlink(home+'/workspace',workspace)
 with open(home+'/.sandbox-sdk/prepared','w'): pass
if not os.path.exists(tmp+'/.sandbox-sdk'):
 try: os.symlink(home+'/.sandbox-sdk',tmp+'/.sandbox-sdk')
 except FileExistsError: pass
`;

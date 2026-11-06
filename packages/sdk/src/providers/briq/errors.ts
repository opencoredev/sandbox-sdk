import { SandboxError, type ErrorCode } from "../../errors.js";

const replayHint = "Inspect or destroy the sandbox before retrying; do not replay the command.";

/** Briq refusals as the SDK's error type. The text is a fixed message, never a response body. */
export function briqError(code: ErrorCode, message: string): SandboxError {
  return new SandboxError(message, {
    code,
    provider: "briq",
    hint: code === "outcome_unknown" ? replayHint : undefined,
  });
}

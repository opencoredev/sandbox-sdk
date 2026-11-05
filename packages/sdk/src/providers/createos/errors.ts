import { SandboxError, type ErrorCode, type HttpFailure } from "../../provider.js";

export function failure(message: string, code: ErrorCode = "provider", sandboxId?: string) {
  return new SandboxError(`${message}. Check the CreateOS sandbox and request options.`, {
    code,
    provider: "createos",
    sandboxId,
  });
}

export function mapError(error: HttpFailure): ErrorCode | undefined {
  if (error.kind !== "status") return undefined;

  if (error.status === 402) return "quota";

  if (error.status === 409) return "invalid_argument";

  return undefined;
}

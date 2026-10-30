import * as Railway from "railway";
import { expect, test } from "vitest";
import { railwayError, rememberRailwayErrors } from "../src/providers/railway/errors.js";

// A bundled copy of an SDK: the same classes, renamed so their names match nothing.
function renamed<C extends new (...args: any[]) => Error>(base: C) {
  return class extends base {};
}

function railwayCopy() {
  return {
    RailwayAuthError: renamed(Railway.RailwayAuthError),
    SandboxFileNotFoundError: renamed(Railway.SandboxFileNotFoundError),
    SandboxNotFoundError: renamed(Railway.SandboxNotFoundError),
    ExecControlUnsupportedError: renamed(Railway.ExecControlUnsupportedError),
    ExecNotStartedError: renamed(Railway.ExecNotStartedError),
    ExecInterruptedError: renamed(Railway.ExecInterruptedError),
    RailwayConnectionError: renamed(Railway.RailwayConnectionError),
    SandboxTimeoutError: renamed(Railway.SandboxTimeoutError),
  };
}

test("railway errors from an earlier loaded SDK copy still map after another copy loads", () => {
  const first = railwayCopy();
  const second = railwayCopy();

  rememberRailwayErrors(first);
  rememberRailwayErrors(second);

  const id = "sb-1";
  const environmentId = "env-1";

  expect(railwayError(new first.SandboxNotFoundError({ id, environmentId })).code).toBe(
    "not_found",
  );
  expect(railwayError(new second.SandboxNotFoundError({ id, environmentId })).code).toBe(
    "not_found",
  );
});

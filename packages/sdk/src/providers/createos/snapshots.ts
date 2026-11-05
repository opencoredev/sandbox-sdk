import { SandboxError, createDeadline, sleep, type SnapshotOptions } from "../../provider.js";
import { record, type CreateosApi } from "./api.js";
import { failure } from "./errors.js";
import { isString } from "../../shared/narrow.js";

export function snapshots(api: CreateosApi, type: "disk" | "full", timeoutMs: number) {
  async function remove(id: string) {
    try {
      await api.json({
        method: "DELETE",
        path: "/v1/snapshots/{snapshotId}",
        params: { snapshotId: id },
      });

      return true;
    } catch (cause) {
      if (cause instanceof SandboxError && cause.code === "not_found") return false;
      throw cause;
    }
  }

  async function capture(sandboxId: string, options?: SnapshotOptions) {
    if (options?.expiresInMs !== undefined && options.expiresInMs !== 0)
      throw failure(
        "Snapshot expiration is unsupported; omit expiresInMs or use 0",
        "unsupported",
        sandboxId,
      );
    const deadline = createDeadline(timeoutMs);

    const created = await api.json({
      method: "POST",
      path: "/v1/sandboxes/{sandboxId}/snapshots",
      sandboxId,
      params: { sandboxId },
      body: { type },
      deadline,
    });

    if (!record(created) || !isString(created.id) || !created.id)
      throw failure(
        "Snapshot creation returned no ID; inspect account snapshots before retrying",
        "outcome_unknown",
        sandboxId,
      );
    const id = created.id;

    try {
      for (;;) {
        const value = await api.json({
          method: "GET",
          path: "/v1/snapshots/{snapshotId}",
          params: { snapshotId: id },
          deadline,
        });

        if (
          !record(value) ||
          value.id !== id ||
          !isString(value.status) ||
          !["creating", "ready", "failed", "deleting"].includes(value.status)
        )
          throw failure(`Invalid metadata for snapshot ${id}`, "provider", sandboxId);

        if (value.status === "ready") return { id };

        if (value.status === "failed") {
          await remove(id);
          throw failure(`Snapshot ${id} capture failed`, "provider", sandboxId);
        }

        if (value.status === "deleting")
          throw failure(`Snapshot ${id} was deleted during capture`, "not_found", sandboxId);
        await sleep(1000, deadline, "createos");
      }
    } catch (cause) {
      if (deadline.signal.aborted)
        throw failure(
          `Snapshot ${id} is still pending; inspect it before retrying or deleting it`,
          "timeout",
          sandboxId,
        );
      throw cause;
    }
  }

  return { capture, remove };
}

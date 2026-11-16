/**
 * A cleanup check for Modal that needs no journal: list every running sandbox in every Environment
 * of the workspace, report the ones the bench or the SDK own, and with `--terminate` stop them and
 * confirm each stop. The operator runs it after every phase (bench/MODAL.md).
 */
import { z } from "zod";
import { nativeModules, type ModalNativeSandbox, type NativeModules } from "./existence.js";
import { pool } from "./timing.js";

/** Tags and App names the bench and the SDK write: `sandbox-bench-*` and `sandbox-sdk*`. */
const owned = /^sandbox-(bench|sdk)(-|$)/;

type SweepClient = InstanceType<NativeModules["modal"]["ModalClient"]>;

/** Why a running sandbox was reported. */
export type SweepReason = "tags" | "app" | "tags-and-app" | "tags-unreadable";

export interface SweptSandbox {
  environment: string;
  id: string;
  /** Its App's name when that name has a bench or SDK prefix, else null. */
  app: string | null;
  /** Its `sandbox-bench-*` and `sandbox-sdk*` tags; null when they could not be read. */
  tags: Record<string, string> | null;
  reason: SweepReason;
  /** With `terminate`: whether Modal confirmed the stop. Null when not terminated. */
  outcome: "stopped" | "unconfirmed" | null;
}

export interface SweepReport {
  checkedAt: string;
  environments: string[];
  /** Every running sandbox seen, owned or not. */
  running: number;
  owned: SweptSandbox[];
  /** Running sandboxes with no bench or SDK tag in an App without such a prefix: left alone. */
  others: number;
}

/** A Modal error saying the sandbox no longer exists: gRPC NOT_FOUND, or Modal's NotFoundError. */
const gone = z.union([
  z.object({ code: z.literal(5) }),
  z.object({ name: z.literal("NotFoundError") }),
]);

/** Poll until Modal reports `box` finished or no longer knows it, up to `ms`. */
async function stopsWithin(box: ModalNativeSandbox, ms: number): Promise<boolean> {
  const end = Date.now() + ms;

  for (;;) {
    try {
      if ((await box.poll()) !== null) return true;
    } catch (error) {
      if (gone.safeParse(error).success) return true;
    }

    if (Date.now() >= end) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, end - Date.now())));
  }
}

/** Sweep one workspace. Read-only unless `terminate`; it never touches a sandbox it does not own. */
export async function sweepModal(options: {
  client: SweepClient;
  terminate?: boolean;
  stopWaitMs?: number;
  concurrency?: number;
}): Promise<SweepReport> {
  const { client, terminate = false, stopWaitMs = 90_000, concurrency = 8 } = options;

  const report: SweepReport = {
    checkedAt: new Date().toISOString(),
    environments: [],
    running: 0,
    owned: [],
    others: 0,
  };

  for await (const environment of client.environments.objects.list()) {
    report.environments.push(environment.name);
    const running = new Set<string>();

    // The whole Environment, every App: Modal lists running sandboxes only.
    for await (const box of client.sandboxes.list({ environment: environment.name }))
      running.add(box.sandboxId);

    report.running += running.size;

    if (!running.size) continue;

    // Which running sandboxes sit in a bench or SDK App: list each such live App.
    const prefixed: { appId: string; name: string }[] = [];

    for await (const app of environment.apps.list())
      if (app.name !== undefined && owned.test(app.name))
        prefixed.push({ appId: app.appId, name: app.name });

    const appOf = new Map<string, string>();

    await pool(prefixed.length, concurrency, async (index) => {
      const app = prefixed[index];

      if (!app || appOf.size === running.size) return;

      for await (const box of client.sandboxes.list({
        appId: app.appId,
        environment: environment.name,
      }))
        if (running.has(box.sandboxId)) appOf.set(box.sandboxId, app.name);
    });

    const ids = [...running];

    await pool(ids.length, concurrency, async (index) => {
      const id = ids[index];

      if (id === undefined) return;
      const box = await client.sandboxes.fromId(id);
      const app = appOf.get(id) ?? null;
      let tags: Record<string, string> | null;

      try {
        tags = Object.fromEntries(
          Object.entries(await box.getTags()).filter(([name]) => owned.test(name)),
        );
      } catch (error) {
        // Stopped between the listing and the read: nothing to report.
        if (gone.safeParse(error).success) return;
        tags = null;
      }

      const tagged = tags !== null && Object.keys(tags).length > 0;

      if (tags !== null && !tagged && app === null) {
        report.others++;

        return;
      }

      const reason: SweepReason =
        tags === null
          ? "tags-unreadable"
          : tagged && app
            ? "tags-and-app"
            : tagged
              ? "tags"
              : "app";

      const entry: SweptSandbox = {
        environment: environment.name,
        id,
        app,
        tags,
        reason,
        outcome: null,
      };

      report.owned.push(entry);

      // Unreadable tags in a foreign App are not proof of ownership: reported, never stopped.
      if (!terminate || (tags === null && app === null)) return;

      try {
        await box.terminate();
      } catch {
        // A lost response or a sandbox already gone: the polls below decide.
      }

      entry.outcome = (await stopsWithin(box, stopWaitMs)) ? "stopped" : "unconfirmed";
    });
  }

  report.owned.sort((a, b) => a.id.localeCompare(b.id));

  return report;
}

/** Whether the sweep leaves nothing of the bench's running: the operator's pass condition. */
export function sweepClean(report: SweepReport, terminated: boolean): boolean {
  return terminated
    ? report.owned.every((entry) => entry.outcome === "stopped")
    : report.owned.length === 0;
}

/** `bun bench modal-sweep [--terminate] [--stop-wait-ms 90000]`. */
export async function modalSweepCommand(args: readonly string[]) {
  const unknown = args.filter(
    (arg, index) =>
      arg !== "--terminate" && arg !== "--stop-wait-ms" && args[index - 1] !== "--stop-wait-ms",
  );

  if (unknown.length) throw new Error(`modal-sweep: unknown argument ${unknown[0]}`);
  const terminate = args.includes("--terminate");
  const wait = args.indexOf("--stop-wait-ms");

  const stopWaitMs =
    wait < 0
      ? 90_000
      : z.coerce
          .number()
          .int()
          .positive()
          .max(600_000)
          .parse(args[wait + 1]);

  const { ModalClient } = await nativeModules.load("modal");
  const client = new ModalClient();
  let report: SweepReport;

  try {
    report = await sweepModal({ client, terminate, stopWaitMs });
  } finally {
    client.close();
  }

  for (const entry of report.owned) process.stdout.write(`modal-sweep: ${JSON.stringify(entry)}\n`);

  const stopped = report.owned.filter((entry) => entry.outcome === "stopped").length;

  process.stdout.write(
    `modal-sweep: ${report.running} running in ${report.environments.length} environment(s) (${report.environments.join(", ")}); ${report.owned.length} bench/SDK-owned${terminate ? `, ${stopped} stopped` : ""}; ${report.others} others left alone\n`,
  );

  if (!sweepClean(report, terminate)) process.exitCode = 1;
}

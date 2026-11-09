import { createHash, randomUUID } from "node:crypto";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { Provider, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";

/**
 * Modal reports cost per App, not per sandbox: `modal billing report` and the JS client's
 * `workspaceBillingReport` carry no sandbox rows, and sandbox tags do not appear in them. To price
 * one attempt, the bench puts each attempt's sandboxes in their own App. The App is chosen by
 * label: a create labelled `appLabel` goes to that App through the adapter's `createApp` option.
 */
export const appLabel = "sandbox-bench-app";

/**
 * One create submitted to a per-attempt App, by the ID the bench gave it. A create whose response
 * never arrived can still have allocated a sandbox in the App; this label lets a later listing
 * tie that sandbox to its journaled attempt.
 */
export const allocationLabel = "sandbox-bench-alloc";

/** Modal App names: letters, digits, dashes, periods and underscores, under 64 characters. */
const appNamePattern = /^[\w.-]{1,63}$/;

const prefix = "sandbox-bench-";

/** The App for one scope: the scope itself when it fits, else a stable hash-suffixed form. */
export function scopedApp(scope: string): string {
  const cleaned = scope.replace(/[^\w.-]/g, "-");
  const name = `${prefix}${cleaned}`;

  if (cleaned === scope && appNamePattern.test(name)) return name;

  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 12);

  return `${prefix}${cleaned.slice(0, 63 - prefix.length - 13)}-${hash}`;
}

/** The App one `bun bench` iteration's sandboxes (its cold create and restores) go to. */
export function attemptApp(run: string, iteration: number): string {
  return scopedApp(`${run}-i${iteration}`);
}

/** The App one realistic attempt's sandbox goes to. */
export function realisticAttemptApp(attemptId: string): string {
  return scopedApp(`rw-${attemptId}`);
}

/**
 * One create in an App, journaled before it is submitted. `submitted` means its outcome is
 * unknown: no sandbox ID came back and Modal did not refuse it, so a sandbox may exist.
 */
export const allocationSchema = z.discriminatedUnion("state", [
  z.object({ id: z.string(), state: z.literal("submitted") }),
  z.object({ id: z.string(), state: z.literal("allocated"), sandboxId: z.string() }),
  z.object({ id: z.string(), state: z.literal("rejected") }),
]);

export type Allocation = z.infer<typeof allocationSchema>;

/**
 * One App in the ownership journal. It is written before any sandbox is allocated in it, and
 * kept after cleanup: recovery prepares it so `list()` sees its sandboxes, and the billing
 * collector attributes its per-App charge to `sandboxes`. Apps are never deleted by the bench.
 */
export const journalAppSchema = z.object({
  provider: z.string(),
  name: z.string().regex(appNamePattern),
  /** Modal's App ID, once the App was looked up or created; billing rows carry it. */
  appId: z.string().nullable(),
  /** Sandboxes created in this App, in creation order, discovered ones included. */
  sandboxes: z.array(z.string()),
  /** Every create submitted to this App. Older journals have none. */
  allocations: z.array(allocationSchema).default([]),
});

export type JournalApp = z.infer<typeof journalAppSchema>;

/** A new journal entry for an App, before it is looked up. */
export function journalApp(provider: string, name: string): JournalApp {
  return { provider, name, appId: null, sandboxes: [], allocations: [] };
}

/** A create journaled in its App: its entry's ID, and the labels the create must carry. */
export interface StartedAllocation {
  readonly id: string;
  /** Route the create to the App (`appLabel`) and tie it to this entry (`allocationLabel`). */
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Journal one create into `app` before it is submitted (persist the journal before submitting).
 * Returns the labels for the create: they route it to the App and tie it to this entry.
 */
export function beginAllocation(app: JournalApp): StartedAllocation {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  app.allocations.push({ id, state: "submitted" });

  return { id, labels: { [appLabel]: app.name, [allocationLabel]: id } };
}

/** Record that the create returned `sandboxId`. */
export function allocated(app: JournalApp, id: string, sandboxId: string) {
  const index = app.allocations.findIndex((entry) => entry.id === id);

  if (index >= 0) app.allocations[index] = { id, state: "allocated", sandboxId };

  if (!app.sandboxes.includes(sandboxId)) app.sandboxes.push(sandboxId);
}

/**
 * Record a failed create. A failure naming the sandbox it came after (a restore whose setup failed
 * once Modal had allocated it) is `allocated`, so billing sees that sandbox in the App. Any other
 * failure stays `submitted`, whatever its code: Modal's client allocates a sandbox and then waits
 * for it to be scheduled, so even a refusal (PERMISSION_DENIED, quota) can follow an allocation it
 * does not name. Billing treats the App as ambiguous until a listing ties a sandbox to the create.
 * (`rejected` stays readable in older journals, but no failure proves nothing was allocated.)
 */
export function failedAllocation(app: JournalApp, id: string, provider: string, cause: unknown) {
  const index = app.allocations.findIndex((entry) => entry.id === id);

  if (
    index >= 0 &&
    cause instanceof SandboxError &&
    cause.provider === provider &&
    cause.sandboxId !== undefined
  )
    allocated(app, id, cause.sandboxId);
}

/** Creates in `app` that may have allocated a sandbox the journal does not name. */
export function ambiguousAllocations(app: Pick<JournalApp, "allocations">): number {
  return app.allocations.filter((entry) => entry.state === "submitted").length;
}

/**
 * Tie a listed sandbox to its journaled App and create, from its labels. A sandbox in a journaled
 * App joins that App's `sandboxes`, and the create it came from (if journaled) becomes
 * `allocated`. Returns whether the journal changed.
 */
export function reconcileDiscovered(
  apps: readonly JournalApp[],
  provider: string,
  sandbox: Pick<SandboxInfo, "id" | "labels">,
): boolean {
  const app = apps.find(
    (entry) => entry.provider === provider && entry.name === sandbox.labels[appLabel],
  );

  if (!app) return false;
  const before = JSON.stringify(app);
  const attempt = app.allocations.find((entry) => entry.id === sandbox.labels[allocationLabel]);

  if (attempt?.state === "submitted") allocated(app, attempt.id, sandbox.id);
  else if (!app.sandboxes.includes(sandbox.id)) app.sandboxes.push(sandbox.id);

  return JSON.stringify(app) !== before;
}

/** Modal's `prepareApp`, as the adapter returns it. */
interface PreparesApps {
  prepareApp(
    name: string,
    options?: { createIfMissing?: boolean },
  ): Promise<{ name: string; appId: string } | null>;
}

/** Whether an adapter can look up Apps ahead of a create (Modal). */
export function preparesApps(provider: Provider): provider is Provider & PreparesApps {
  return "prepareApp" in provider && typeof provider.prepareApp === "function";
}

/** A running restore its creator never finished setting up, as Modal's `listPending` reads it. */
export interface PendingSandbox {
  id: string;
  labels: Record<string, string>;
}

/** Modal's `listPending`, as the adapter returns it. */
interface ListsPending {
  listPending(labels: Record<string, string>): Promise<PendingSandbox[]>;
}

/** Whether an adapter can list restores still tagged pending (Modal). */
export function listsPending(provider: Provider): provider is Provider & ListsPending {
  return "listPending" in provider && typeof provider.listPending === "function";
}

/**
 * Running sandboxes of `run` that a restore allocated but whose creator stopped before setup, so
 * `list()` never shows them. Ownership is the exact tag read by ID: this run's label and the SDK's
 * pending marker. Empty for adapters without the listing.
 */
export async function pendingForRun(provider: Provider, run: string): Promise<PendingSandbox[]> {
  if (!listsPending(provider)) return [];

  return (await provider.listPending({ "sandbox-bench-run": run })).filter(
    (entry) =>
      entry.labels["sandbox-bench-run"] === run && entry.labels["sandbox-sdk"] === "pending",
  );
}

/**
 * Make every journaled App of `provider` visible to its `list()` in a fresh process, without
 * creating any: an App journaled but never created holds no sandboxes. Returns the App IDs found.
 */
export async function prepareJournaledApps(
  provider: Provider,
  apps: readonly JournalApp[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  if (!preparesApps(provider)) return found;

  for (const app of apps) {
    if (app.provider !== provider.name) continue;
    const prepared = await provider.prepareApp(app.name, { createIfMissing: false });

    if (prepared) found.set(app.name, prepared.appId);
  }

  return found;
}

/** The `createApp` factory option: a create labelled with `appLabel` goes to that App. */
export function createAppByLabel({
  labels,
}: {
  readonly labels: Readonly<Record<string, string>>;
}) {
  return labels[appLabel];
}

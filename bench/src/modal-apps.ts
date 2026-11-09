import { createHash } from "node:crypto";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";

/**
 * Modal reports cost per App, not per sandbox: `modal billing report` and the JS client's
 * `workspaceBillingReport` carry no sandbox rows, and sandbox tags do not appear in them. To price
 * one attempt, the bench puts each attempt's sandboxes in their own App. The App is chosen by
 * label: a create labelled `appLabel` goes to that App through the adapter's `createApp` option.
 */
export const appLabel = "sandbox-bench-app";

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
 * One App in the ownership journal. It is written before any sandbox is allocated in it, and
 * kept after cleanup: recovery prepares it so `list()` sees its sandboxes, and the billing
 * collector attributes its per-App charge to `sandboxes`. Apps are never deleted by the bench.
 */
export const journalAppSchema = z.object({
  provider: z.string(),
  name: z.string().regex(appNamePattern),
  /** Modal's App ID, once the App was looked up or created; billing rows carry it. */
  appId: z.string().nullable(),
  /** Sandboxes created in this App, in creation order. */
  sandboxes: z.array(z.string()),
});

export type JournalApp = z.infer<typeof journalAppSchema>;

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

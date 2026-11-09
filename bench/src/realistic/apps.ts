/**
 * The realistic harness's App journal (`apps.jsonl`) and confirmed stops (`stops.jsonl`), in the
 * run's output directory: the counterparts of `ownership.json`'s `apps` and the destroy rows'
 * `confirmedStopMs` in `bun bench`. Modal bills per App, so each realistic attempt's sandbox goes
 * to its own App (modal-apps.ts). Each apps.jsonl line is a whole `JournalApp` snapshot, appended
 * before the App is looked up, with its App ID, before the create is submitted, and after it
 * returns or fails; the last line per App wins. Recovery prepares every journaled App so `list()`
 * sees its sandboxes; billing attributes each App's charge to its sandboxes and treats it as
 * settled only after the sandbox's confirmed stop.
 */
import { appendFile, readFile } from "node:fs/promises";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";
import type { OwnedApp } from "../billing/input.js";
import { isMissingFile } from "../files.js";
import {
  allocated,
  ambiguousAllocations,
  beginAllocation,
  failedAllocation,
  journalApp,
  journalAppSchema,
  preparesApps,
  realisticAttemptApp,
  type JournalApp,
} from "../modal-apps.js";
import { destroyTimings } from "../providers.js";

export const appJournalFile = "apps.jsonl";

export const stopJournalFile = "stops.jsonl";

const key = (app: Pick<JournalApp, "provider" | "name">) => `${app.provider}/${app.name}`;

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim());
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

/** Append the App's current state; the journal must be on disk before the step it precedes. */
export async function persistApp(path: string, app: JournalApp): Promise<void> {
  await appendFile(path, JSON.stringify(app) + "\n");
}

/** The journal's Apps, the latest snapshot of each. A missing journal has none. */
export async function readAppJournal(path: string): Promise<JournalApp[]> {
  const latest = new Map<string, JournalApp>();

  for (const line of await lines(path)) {
    const app = journalAppSchema.parse(JSON.parse(line));
    latest.set(key(app), app);
  }

  return [...latest.values()];
}

/** Each journaled sandbox's App as the billing collector reads it, keyed `provider/sandboxId`. */
export function ownedApps(apps: readonly JournalApp[]): Map<string, OwnedApp> {
  return new Map(
    apps.flatMap((app) => {
      const owner: OwnedApp = {
        name: app.name,
        appId: app.appId,
        sandboxes: app.sandboxes,
        ambiguous: ambiguousAllocations(app),
      };

      return app.sandboxes.map((id): [string, OwnedApp] => [`${app.provider}/${id}`, owner]);
    }),
  );
}

const stopSchema = z.object({
  provider: z.string(),
  sandboxId: z.string(),
  /** When destroy returned after Modal reported the stop: an upper bound on the stop. */
  confirmedStopAt: z.iso.datetime(),
  requestMs: z.number().nullable(),
  stoppedMs: z.number(),
});

/** Each sandbox's confirmed stop, keyed `provider/sandboxId`; the latest wins. */
export async function readStops(path: string): Promise<Map<string, string>> {
  const stops = new Map<string, string>();

  for (const line of await lines(path)) {
    const stop = stopSchema.parse(JSON.parse(line));
    stops.set(`${stop.provider}/${stop.sandboxId}`, stop.confirmedStopAt);
  }

  return stops;
}

/** One attempt's App: journaled before allocation, resolved outside any timed phase. */
export interface AttemptApp {
  /** Labels for the attempt's create: they route it to the App and tie it to its journal entry. */
  readonly labels: Readonly<Record<string, string>>;
  /** The create returned this sandbox. */
  created(sandboxId: string): Promise<void>;
  /** The create threw; the entry stays ambiguous unless Modal definitively refused it. */
  failed(cause: unknown): Promise<void>;
  /** Destroy returned; journals the confirmed stop when the adapter reported one. */
  destroyed(sandboxId: string): Promise<void>;
}

/**
 * Journal the attempt's App, look it up or create it, then journal its one create before it is
 * submitted. Throws, failing the attempt before any sandbox exists, when the adapter cannot
 * prepare Apps or Modal does not return one.
 */
export async function prepareAttemptApp(
  paths: { apps: string; stops: string },
  provider: Provider,
  attemptId: string,
  now: () => number = Date.now,
): Promise<AttemptApp> {
  const app = journalApp(provider.name, realisticAttemptApp(attemptId));
  await persistApp(paths.apps, app);

  if (!preparesApps(provider)) throw new Error(`${provider.name} cannot prepare an App`);
  const prepared = await provider.prepareApp(app.name);

  if (!prepared) throw new Error(`App ${app.name} could not be created`);
  app.appId = prepared.appId;
  const allocation = beginAllocation(app);
  await persistApp(paths.apps, app);

  return {
    labels: allocation.labels,
    created: async (sandboxId) => {
      allocated(app, allocation.id, sandboxId);
      await persistApp(paths.apps, app);
    },
    failed: async (cause) => {
      failedAllocation(app, allocation.id, provider.name, cause);
      await persistApp(paths.apps, app);
    },
    destroyed: async (sandboxId) => {
      const timing = destroyTimings.get(`${provider.name}/${sandboxId}`);
      destroyTimings.delete(`${provider.name}/${sandboxId}`);

      if (!timing || timing.stoppedMs === null) return;

      const stop: z.infer<typeof stopSchema> = {
        provider: provider.name,
        sandboxId,
        confirmedStopAt: new Date(now()).toISOString(),
        requestMs: timing.requestMs,
        stoppedMs: timing.stoppedMs,
      };

      await appendFile(paths.stops, JSON.stringify(stop) + "\n");
    },
  };
}

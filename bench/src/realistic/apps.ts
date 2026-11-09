/**
 * The realistic harness's App journal (`apps.jsonl` in the run's output directory), the
 * counterpart of `ownership.json`'s `apps` in `bun bench`. Modal bills per App, so each realistic
 * attempt's sandbox goes to its own App (modal-apps.ts). Each line is a whole `JournalApp`
 * snapshot, appended before the App is looked up, again with its App ID, and again with each
 * sandbox created in it; the last line per App wins. Recovery prepares every journaled App so
 * `list()` sees its sandboxes; billing attributes each App's charge to its sandboxes.
 */
import { appendFile, readFile } from "node:fs/promises";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import {
  appLabel,
  journalAppSchema,
  preparesApps,
  realisticAttemptApp,
  type JournalApp,
} from "../modal-apps.js";
import { isMissingFile } from "../files.js";

export const appJournalFile = "apps.jsonl";

const key = (app: Pick<JournalApp, "provider" | "name">) => `${app.provider}/${app.name}`;

/** The journal's Apps, the latest snapshot of each. A missing journal has none. */
export async function readAppJournal(path: string): Promise<JournalApp[]> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const latest = new Map<string, JournalApp>();

  for (const line of text.split("\n"))
    if (line.trim()) {
      const app = journalAppSchema.parse(JSON.parse(line));
      latest.set(key(app), app);
    }

  return [...latest.values()];
}

/** One attempt's App: journaled before allocation, resolved outside any timed phase. */
export interface AttemptApp {
  /** Labels for the attempt's creates, which route them to the App (`createApp`). */
  readonly labels: Readonly<Record<string, string>>;
  /** Journal a sandbox created in the App. */
  created(sandboxId: string): Promise<void>;
}

/**
 * Journal the attempt's App, then look it up or create it. Throws, failing the attempt before any
 * sandbox exists, when the adapter cannot prepare Apps or Modal does not return one.
 */
export async function prepareAttemptApp(
  path: string,
  provider: Provider,
  attemptId: string,
): Promise<AttemptApp> {
  const app: JournalApp = {
    provider: provider.name,
    name: realisticAttemptApp(attemptId),
    appId: null,
    sandboxes: [],
  };

  const write = () => appendFile(path, JSON.stringify(app) + "\n");

  await write();

  if (!preparesApps(provider)) throw new Error(`${provider.name} cannot prepare an App`);
  const prepared = await provider.prepareApp(app.name);

  if (!prepared) throw new Error(`App ${app.name} could not be created`);
  app.appId = prepared.appId;
  await write();

  return {
    labels: { [appLabel]: app.name },
    created: async (sandboxId) => {
      app.sandboxes.push(sandboxId);
      await write();
    },
  };
}

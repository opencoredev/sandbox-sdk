import type { PostHog, PostHogConfig } from "posthog-js";

/**
 * Public project key for the "Sandbox SDK" PostHog project (698825). Safe to ship.
 * The docs use the same key in apps/docs/blume.config.ts.
 */
export const posthogKey = "phc_zxoHDZFt8NiXpZyfWXpHQnhxSd4h7xqgHkkpiyHgwPbq";

/**
 * Web analytics only: pageviews, page leaves, clicks and web vitals. No session
 * replay, no surveys, and nothing for visitors who send Do Not Track.
 */
export const posthogConfig = {
  api_host: "https://us.i.posthog.com",
  defaults: "2026-08-30",
  capture_pageview: "history_change",
  capture_pageleave: true,
  capture_performance: { web_vitals: true, network_timing: false },
  autocapture: { capture_copied_text: false },
  disable_session_recording: true,
  disable_surveys: true,
  enable_heatmaps: false,
  capture_dead_clicks: false,
  respect_dnt: true,
  person_profiles: "identified_only",
} satisfies Partial<PostHogConfig>;

let client: Promise<PostHog> | undefined;

/**
 * Loads and starts PostHog once. The import is dynamic so the SDK stays out of
 * the first paint. Outside production it never loads, so `next dev` sends nothing.
 */
export function loadPostHog(): Promise<PostHog> | undefined {
  if (process.env.NODE_ENV !== "production") return undefined;

  client ??= import("posthog-js").then(({ default: posthog }) => {
    if (!posthog.__loaded) posthog.init(posthogKey, posthogConfig);

    return posthog;
  });

  return client;
}

/** Events the landing page sends on its own, beyond what autocapture records. */
type SiteEvent = "install_command_copied" | "agent_prompt_copied";

/** Sends a custom event. A failed load never reaches the caller. */
export function track(event: SiteEvent, properties?: Record<string, string>): void {
  void loadPostHog()
    ?.then((posthog) => posthog.capture(event, properties))
    .catch(() => {});
}

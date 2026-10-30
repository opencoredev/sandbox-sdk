"use client";

import { useEffect } from "react";

import { loadPostHog } from "@/lib/posthog";

/** Starts PostHog after hydration. */
export function PostHogProvider() {
  useEffect(() => {
    void loadPostHog()?.catch(() => {});
  }, []);

  return null;
}

"use client";

import { Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ThemeSwitchProps } from "fumadocs-ui/layouts/shared/slots/theme-switch";
import { useTheme } from "fumadocs-ui/provider/base";
import { useEffect, useState } from "react";

export function CompactThemeSwitch({ className }: ThemeSwitchProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dark = mounted && resolvedTheme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className={`inline-flex size-8 items-center justify-center rounded-lg text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring ${className ?? ""}`}
    >
      <HugeiconsIcon icon={dark ? Sun03Icon : Moon02Icon} size={16} strokeWidth={2} />
    </button>
  );
}

import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { BrandMark } from "@/components/brand-mark";
import { CompactThemeSwitch } from "@/components/compact-theme-switch";

import { appName, gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <BrandMark className="h-5 w-auto" />
          <span>{appName}</span>
        </>
      ),
      url: "/docs",
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    slots: {
      themeSwitch: CompactThemeSwitch,
    },
  };
}

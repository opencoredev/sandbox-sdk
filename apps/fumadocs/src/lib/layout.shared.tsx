import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { BrandMark } from "@/components/brand-mark";

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
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}

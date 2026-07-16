"use client";

import { HomeLayout } from "fumadocs-ui/layouts/home";
import { usePathname } from "next/navigation";

import { baseOptions } from "@/lib/layout.shared";

export default function Layout({ children }: LayoutProps<"/">) {
  const pathname = usePathname();
  if (pathname === "/") return children;
  return <HomeLayout {...baseOptions()}>{children}</HomeLayout>;
}

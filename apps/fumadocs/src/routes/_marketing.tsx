import { createFileRoute, Outlet } from "@tanstack/react-router";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";

export const Route = createFileRoute("/_marketing")({
  component: MarketingLayout,
});

function MarketingLayout() {
  return (
    <HomeLayout {...baseOptions()}>
      <Outlet />
    </HomeLayout>
  );
}

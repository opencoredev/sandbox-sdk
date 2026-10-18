import { defineComponents } from "blume";
import ProviderTab from "./components/ProviderTab.astro";
import ProviderTabs from "./components/ProviderTabs.astro";

export default defineComponents({
  mdx: {
    ProviderTab,
    ProviderTabs,
  },
});

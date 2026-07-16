import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { ProviderCapabilityMatrix } from "@/components/capability-table";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ProviderCapabilityMatrix,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}

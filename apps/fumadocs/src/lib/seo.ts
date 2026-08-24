import { appName } from "./shared";

export const siteUrl = "https://sandbox-sdk.app";
export const repoUrl = "https://github.com/opencoredev/sandbox-sdk";
export const npmUrl = "https://www.npmjs.com/package/@opencoredev/sandbox-sdk";

export const siteTagline = "One TypeScript API for every sandbox provider";

export const siteDescription =
  "Sandbox SDK is the open-source TypeScript SDK for running code in isolated sandboxes — one typed API for E2B, Daytona, Vercel Sandbox, Railway, and more.";

export const siteDescriptionLong =
  "Sandbox SDK is an open-source TypeScript SDK for running code in isolated sandboxes. One typed API for files, commands, processes, ports, and snapshots across Local, E2B, Daytona, Vercel Sandbox, Upstash Box, Ascii Box, and Railway.";

export const siteKeywords = [
  "sandbox SDK",
  "TypeScript sandbox SDK",
  "code execution sandbox",
  "AI agent sandbox",
  "run untrusted code",
  "E2B",
  "Daytona",
  "Vercel Sandbox",
  "Upstash Box",
  "Railway sandbox",
];

const organizationId = `${siteUrl}/#organization`;
const websiteId = `${siteUrl}/#website`;

export const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": organizationId,
  name: "OpenCore",
  url: "https://opencore.dev",
  sameAs: [repoUrl, "https://github.com/opencoredev"],
};

export const websiteSchema = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": websiteId,
  name: appName,
  alternateName: "@opencoredev/sandbox-sdk",
  url: siteUrl,
  description: siteDescriptionLong,
  inLanguage: "en",
  publisher: { "@id": organizationId },
};

export const softwareSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  "@id": `${siteUrl}/#software`,
  name: appName,
  alternateName: "@opencoredev/sandbox-sdk",
  description: siteDescriptionLong,
  url: siteUrl,
  codeRepository: repoUrl,
  programmingLanguage: "TypeScript",
  runtimePlatform: ["Node.js", "Bun"],
  license: "https://opensource.org/licenses/MIT",
  author: { "@id": organizationId },
  maintainer: { "@id": organizationId },
  isAccessibleForFree: true,
  keywords: siteKeywords.join(", "),
  downloadUrl: npmUrl,
};

export interface Faq {
  question: string;
  answer: string;
}

export const faqs: readonly Faq[] = [
  {
    question: "What is Sandbox SDK?",
    answer:
      "Sandbox SDK is an open-source TypeScript SDK that gives every sandbox provider the same typed API. You write files, commands, processes, ports, and snapshots once, then run that code on Local, E2B, Daytona, Vercel Sandbox, Upstash Box, Ascii Box, or Railway without rewriting your application.",
  },
  {
    question: "Which sandbox providers does Sandbox SDK support?",
    answer:
      "Local (an AgentOS VM that ships with the package), E2B, Daytona, Vercel Sandbox, Upstash Box, Ascii Box, and Railway Sandboxes. Cloud providers use their official SDKs and your own credentials.",
  },
  {
    question: "How do I switch sandbox providers?",
    answer:
      "Change the provider passed to createSandbox. Going from Local to E2B is replacing local() with e2b(); the rest of your application code stays the same because the contract does not change.",
  },
  {
    question: "Can I still use provider-specific features?",
    answer:
      "Yes. The unified surface only covers what every provider can do cleanly, and sandbox.raw exposes the underlying provider SDK object with its own types, so provider-specific APIs stay available without an escape from type safety.",
  },
  {
    question: "Is Sandbox SDK free to use?",
    answer:
      "Yes. Sandbox SDK is MIT licensed and free to use, including commercially. You only pay whichever sandbox provider you choose to run against, and Local runs without any hosted provider at all.",
  },
  {
    question: "Does Sandbox SDK work with AI agents?",
    answer:
      "Yes. Sandbox SDK is designed for coding agents that need to run untrusted or model-generated code, and ships integrations for the AI SDK, Mastra, and Eve, plus an agent skill so assistants can read the docs directly.",
  },
  {
    question: "What runtimes does Sandbox SDK require?",
    answer:
      "Node.js 22 or 24, or Bun 1.3 and newer. Node.js 24 and Bun run the await using syntax directly; on Node.js 22 you can compile to ES2022 or use the callback-style withSandbox() helper.",
  },
];

export const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": `${siteUrl}/#faq`,
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: { "@type": "Answer", text: faq.answer },
  })),
};

export function breadcrumbSchema(trail: readonly { name: string; url: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${siteUrl}${item.url}`,
    })),
  };
}

export function techArticleSchema(article: { title: string; description?: string; url: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: article.title,
    description: article.description,
    url: `${siteUrl}${article.url}`,
    inLanguage: "en",
    isPartOf: { "@id": websiteId },
    about: { "@id": `${siteUrl}/#software` },
    author: { "@id": organizationId },
    publisher: { "@id": organizationId },
  };
}

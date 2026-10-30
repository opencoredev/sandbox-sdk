import type { NextConfig } from "next";

const config: NextConfig = {
  // The preview proxy lives at /preview/ and relies on the trailing slash for relative asset URLs.
  skipTrailingSlashRedirect: true,
  // The SDK and provider clients talk to Docker sockets and native SDKs; keep them out of the bundle.
  serverExternalPackages: ["@opencoredev/sandbox-sdk", "e2b", "@vercel/sandbox", "@daytonaio/sdk"],
};

export default config;

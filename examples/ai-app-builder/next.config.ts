import type { NextConfig } from "next";

const config: NextConfig = {
  // The preview proxy lives at /preview/ and relies on the trailing slash for relative asset URLs.
  skipTrailingSlashRedirect: true,
  // The SDK talks to Docker sockets and loads @vercel/sandbox on demand; keep both out of the bundle.
  serverExternalPackages: ["@opencoredev/sandbox-sdk", "@vercel/sandbox"],
};

export default config;

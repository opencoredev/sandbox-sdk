/** This package's version. `scripts/sync-version.ts` rewrites it after `changeset version`; a test checks it against package.json. */
export const version = "1.0.3";

/** Sent on every request the SDK makes to a provider. */
export const userAgent = `sandbox-sdk/${version}`;

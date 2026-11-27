/**
 * Every pinned input of the Docker and services benchmark, in one place. Hashes were checked
 * against the upstream's own published hash where one exists (Maven sha1, redis-hashes, Node
 * SHASUMS256, Compose's .sha256) on 2026-11-23; Docker publishes none for its static bundles, so
 * those are the sha256 of the bytes download.docker.com served that day.
 */

export interface PinnedDownload {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Same server versions on both paths: the images' PG_VERSION / REDIS_VERSION and the binaries. */
export const serverVersions = { postgres: "16.16", redis: "7.4.12" } as const;

/** compose.yaml's images, by multi-arch index digest (Docker Hub, 2026-11-23). */
export const images = {
  postgres: "postgres:16@sha256:3950ad7c3148ca2175ef1b6c36c9efbf78957ae8fbe8b3a5d7c35af50500382f",
  redis: "redis:7@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90",
} as const;

/**
 * Node for the test runner, uploaded from the host so every provider runs the same one. The gzip
 * build, because minimal images often have no xz.
 */
export const node: PinnedDownload & { readonly version: string } = {
  version: "22.23.5",
  url: "https://nodejs.org/dist/v22.23.5/node-v22.23.5-linux-x64.tar.gz",
  sha256: "c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1",
  bytes: 56_856_114,
};

/** Relocatable Postgres 16.16 server binaries (initdb, pg_ctl, postgres) with their own libraries. */
export const zonkyPostgres: PinnedDownload = {
  url: "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/16.16.0/embedded-postgres-binaries-linux-amd64-16.16.0.jar",
  sha256: "585c1697098e5fbc8716b26901cdb3a829e6f3be5b5efa13dfe87b7e5cc55f5b",
  bytes: 14_723_129,
};

/** Redis source, built here into one static redis-server (no TLS, libc malloc). */
export const redisSource: PinnedDownload = {
  url: "https://download.redis.io/releases/redis-7.4.12.tar.gz",
  sha256: "56588ee1648539556f2b6cf4e873e3734afbbe40fa952fec2fcd6b6d7dae2924",
  bytes: 3_551_536,
};

/** Docker's static x86_64 bundle (dockerd, containerd, runc, docker-proxy, CLI), fetched in the guest. */
export const dockerStatic: PinnedDownload & { readonly version: string } = {
  version: "29.9.3",
  url: "https://download.docker.com/linux/static/stable/x86_64/docker-29.9.3.tgz",
  sha256: "3fb5d1f13014c18cc54945bc177c58a9056a482dada031e17d12cf2e6922c973",
  bytes: 86_360_685,
};

/** Rootless extras for the same Docker version (rootlesskit, dockerd-rootless.sh). */
export const dockerRootlessExtras: PinnedDownload = {
  url: "https://download.docker.com/linux/static/stable/x86_64/docker-rootless-extras-29.9.3.tgz",
  sha256: "c41b7194dca722fe929bc0225fc87f3166c97e67d50a521533b0b23f3c79a466",
  bytes: 12_014_002,
};

/** Compose v2 CLI plugin, fetched in the guest when the image has no `docker compose`. */
export const composePlugin: PinnedDownload & { readonly version: string } = {
  version: "5.6.1",
  url: "https://github.com/docker/compose/releases/download/v5.6.1/docker-compose-linux-x86_64",
  sha256: "47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0",
  bytes: 32_676_477,
};

/** The fixture's test file has exactly this many tests; a green run passes all of them. */
export const expectedTests = 9;

/** The fixture directory, relative to bench/. */
export const fixtureDir = "fixtures/services-api";

/**
 * What each provider's own docs say about Docker in the sandbox and native multi-container or
 * sidecar services. This is documentation, kept apart from the guest probe: the capability table
 * shows it as "docs say", never as a measured result. A provider missing here was not researched.
 *
 * Researched 2026-11-23 from each provider's docs. Quotes came through a page summarizer; the
 * Modal (both pages), boxd and Archil quotes were re-checked against the raw pages that day.
 */
export interface DocClaim {
  readonly documented: boolean;
  readonly how: string;
  readonly quote: string | null;
  readonly url: string | null;
}

export interface NativeServiceDoc {
  readonly checkedAt: string;
  readonly docker: DocClaim;
  readonly sidecar: DocClaim;
}

const checkedAt = "2026-11-23";

const none = (how = "not documented"): DocClaim => ({
  documented: false,
  how,
  quote: null,
  url: null,
});

const docs = {
  e2b: {
    checkedAt,
    docker: {
      documented: true,
      how: "A custom template with Docker or Docker Compose installed",
      quote: "Sandbox with Docker or Docker Compose installed for running containers",
      url: "https://docs.e2b.dev/template/examples/docker",
    },
    sidecar: none(),
  },
  daytona: {
    checkedAt,
    docker: {
      documented: true,
      how: "A Docker-in-Docker snapshot",
      quote: "Sandboxes can run Docker containers inside them",
      url: "https://www.daytona.io/docs/en/snapshots/",
    },
    sidecar: none(),
  },
  modal: {
    checkedAt,
    docker: {
      documented: true,
      how: "The VM runtime (runtime: vm); start dockerd yourself",
      quote: "Use the VM runtime to run Docker in a Sandbox.",
      url: "https://modal.com/docs/guide/vm-sandboxes",
    },
    sidecar: {
      documented: true,
      how: "Sandbox Sidecars (Beta): separate containers next to the sandbox",
      quote: "Sandbox Sidecars Beta",
      url: "https://modal.com/docs/guide/sandbox-sidecars",
    },
  },
  vercel: {
    checkedAt,
    docker: {
      documented: true,
      how: "System privileges allow container runtimes",
      quote:
        "Run workloads that need system-level privileges, such as container runtimes like Docker",
      url: "https://vercel.com/docs/sandbox",
    },
    sidecar: none(),
  },
  freestyle: {
    checkedAt,
    docker: {
      documented: true,
      how: "Docker Engine preinstalled on Ubuntu base snapshots",
      quote:
        "Freestyle sandboxes are microVMs with a full Linux kernel, so the Docker Engine runs inside one natively.",
      url: "https://www.freestyle.sh/docs/guides/run-docker-in-a-sandbox",
    },
    sidecar: none(),
  },
  boxd: {
    checkedAt,
    docker: {
      documented: true,
      how: "Docker Engine, Compose and Buildx preinstalled, daemon running",
      quote:
        "Docker Engine, Compose, and Buildx come pre-installed on every machine, with the daemon already running.",
      url: "https://docs.boxd.sh/guides/run-docker",
    },
    sidecar: none(),
  },
  instabox: {
    checkedAt,
    docker: {
      documented: true,
      how: "A full Linux VM with root and Docker",
      quote:
        "InstaBox gives each agent a full Linux VM in the cloud, with its own kernel, root, and Docker.",
      url: "https://instabox.sh/docs",
    },
    sidecar: none(),
  },
  archil: {
    checkedAt,
    docker: {
      documented: true,
      how: "Supported; start the daemon yourself",
      quote: "Supported. Start the Docker daemon inside the sandbox before using it.",
      url: "https://docs.archil.com/compute/sandboxes/introduction",
    },
    sidecar: none(),
  },
  beam: {
    checkedAt,
    docker: {
      documented: true,
      how: "Nested containers and Compose services",
      quote: "build images and run nested containers or Compose services.",
      url: "https://docs.beam.cloud/v2/sandbox/overview",
    },
    sidecar: none(),
  },
  baseten: {
    checkedAt,
    docker: none("Only building an image from a Dockerfile is documented"),
    sidecar: none(),
  },
  upstash: { checkedAt, docker: none(), sidecar: none() },
  superserve: {
    checkedAt,
    docker: {
      documented: true,
      how: "Firecracker microVM; Docker and Compose run inside",
      quote:
        "Every Superserve sandbox is a full Firecracker microVM with its own kernel, so Docker runs inside the sandbox",
      url: "https://docs.superserve.ai/sandbox/docker",
    },
    sidecar: none(),
  },
  tenki: { checkedAt, docker: none("Not in Luxor's quickstart"), sidecar: none() },
  boat: {
    checkedAt,
    docker: {
      documented: true,
      how: "CI docs only: jobs run on full VMs with Docker; sandbox docs say nothing",
      quote: "Each job runs on a full Linux virtual machine with Docker, not in a container.",
      url: "https://docs.boat.dev/ci",
    },
    sidecar: {
      documented: true,
      how: "CI docs only: services containers next to a CI job, not for sandboxes",
      quote: "services: containers (Postgres, Redis) start next to the job, on localhost.",
      url: "https://docs.boat.dev/ci",
    },
  },
} satisfies Readonly<Record<string, NativeServiceDoc>>;

/** The docs entry for a provider, or null when it was not researched. */
export function nativeServiceDoc(provider: string): NativeServiceDoc | null {
  return Object.hasOwn(docs, provider)
    ? (new Map(Object.entries(docs)).get(provider) ?? null)
    : null;
}

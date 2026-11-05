import type { Provider } from "../../provider.js";

/** Options for {@link briq}. */
export interface BriqOptions {
  /** Defaults to BRIQ_API_KEY; required on first use. */
  apiKey?: string;
  /** HTTP(S) API origin. Defaults to BRIQ_API_URL, then https://api.briq.cloud. */
  baseUrl?: string;
  /** Stack that holds this provider's sandboxes. Default: `opencore`. */
  stack?: string;
  /** Custom HTTP transport. It must honor `AbortSignal`. The adapter refuses redirects. */
  fetch?: typeof fetch;
}

/** The handle `box.native` returns: the sandbox ID and its record, never a credential. */
export interface BriqNative {
  id: string;
  status(): Promise<{
    id: string;
    name: string;
    state: string;
    createdAt: string;
    labels: Record<string, string>;
  }>;
}

export type BriqProvider = Provider<BriqNative, never>;

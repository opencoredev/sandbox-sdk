import type { Provider } from "@opencoredev/sandbox-sdk/provider";

/** An adapter that can name the sleeping machines `list()` leaves out without waking them (boxd). */
interface ListsSleeping {
  listSleeping(): Promise<{ id: string }[]>;
}

function listsSleeping(provider: Provider): provider is Provider & ListsSleeping {
  return "listSleeping" in provider && typeof provider.listSleeping === "function";
}

/**
 * Sleeping machines `list()` can't show, because reading their labels would wake them, billed,
 * whoever owns them. Any may be a run's leftover, so cleanup reports them instead of passing as
 * clean. Empty for adapters without the listing.
 */
export async function sleepingUnchecked(provider: Provider): Promise<string[]> {
  return listsSleeping(provider) ? (await provider.listSleeping()).map((m) => m.id) : [];
}

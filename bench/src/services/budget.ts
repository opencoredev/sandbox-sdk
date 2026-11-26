/**
 * Spend guard for services runs: an attempt reserves its timeout-length estimate before it
 * starts, and settles to its measured estimate when it ends. An attempt that would cross the run
 * cap or its provider's cap is refused, not shrunk. Estimates are list prices, not invoices.
 */
export class SpendGuard {
  private spent = 0;
  private reserved = 0;
  private readonly byProvider = new Map<string, number>();

  constructor(
    readonly capUSD: number,
    readonly providerCapUSD: ReadonlyMap<string, number> = new Map(),
  ) {
    if (!Number.isFinite(capUSD) || capUSD <= 0)
      throw new Error(`The spend cap must be a positive number of dollars, got ${capUSD}`);
  }

  /** Reserve `usd` for one attempt; null when it would cross a cap. */
  reserve(provider: string, usd: number): { provider: string; usd: number } | null {
    const providerUsed = this.byProvider.get(provider) ?? 0;
    const providerCap = this.providerCapUSD.get(provider) ?? Number.POSITIVE_INFINITY;

    if (this.spent + this.reserved + usd > this.capUSD || providerUsed + usd > providerCap)
      return null;
    this.reserved += usd;
    this.byProvider.set(provider, providerUsed + usd);

    return { provider, usd };
  }

  /** Replace a reservation with the attempt's measured estimate (the reservation when unknown). */
  settle(reservation: { provider: string; usd: number }, actualUSD: number | null) {
    const actual = actualUSD ?? reservation.usd;
    this.reserved -= reservation.usd;
    this.spent += actual;
    this.byProvider.set(
      reservation.provider,
      (this.byProvider.get(reservation.provider) ?? 0) - reservation.usd + actual,
    );
  }

  state() {
    return { spentUSD: this.spent, reservedUSD: this.reserved };
  }
}

/** `a=1,b=2.5` as a map of positive dollar caps. */
export function parseProviderCaps(value: string | undefined): Map<string, number> {
  const caps = new Map<string, number>();

  for (const item of (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [name, raw] = item.split("=");
    const usd = Number(raw);

    if (!name || !Number.isFinite(usd) || usd <= 0)
      throw new Error(`Provider cap must look like provider=dollars, got ${item}`);
    caps.set(name, usd);
  }

  return caps;
}

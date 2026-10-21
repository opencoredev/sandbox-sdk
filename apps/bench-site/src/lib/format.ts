export type Unit = "s" | "ms" | "ops/s" | "MB/s" | "IOPS";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatValue(value: number, unit: Unit) {
  switch (unit) {
    case "s":
      return `${value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1) : value.toFixed(0)} s`;
    case "ms":
      return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
    case "ops/s":
      return `${compact.format(value)}/s`;
    case "MB/s":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} GB/s` : `${value.toFixed(0)} MB/s`;
    case "IOPS":
      return `${compact.format(value)} IOPS`;
  }
}

/** The number alone, for a column label whose unit the chart subtitle already gives. */
export function formatShort(value: number, unit: Unit) {
  switch (unit) {
    case "s":
    case "ms":
      return value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1) : value.toFixed(0);
    case "ops/s":
    case "MB/s":
    case "IOPS":
      return compact.format(value);
  }
}

/** How a chart subtitle names a unit. */
export const unitName = {
  s: "seconds",
  ms: "milliseconds",
  "ops/s": "operations per second",
  "MB/s": "MB per second",
  IOPS: "operations per second",
} as const satisfies Record<Unit, string>;

export const formatPercent = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;

export function formatMoney(value: number, currency: string | null) {
  const symbol = currency === "EUR" ? "€" : "$";
  // Three decimals under a dollar: several hourly prices sit within a few cents of each other.
  return `${symbol}${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

export const formatCount = (value: number) => value.toLocaleString("en-US");

export function formatGiB(value: number) {
  if (value < 1) return `${Math.round(value * 1024)} MB`;
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} GB`;
}

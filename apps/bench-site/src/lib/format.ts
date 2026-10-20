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

export const formatPercent = (value: number, digits = 1) => `${(value * 100).toFixed(digits)}%`;

export function formatMoney(value: number, currency: string | null) {
  const symbol = currency === "EUR" ? "€" : "$";
  return `${symbol}${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
}

export const formatCount = (value: number) => value.toLocaleString("en-US");

export function formatGiB(value: number) {
  if (value < 1) return `${Math.round(value * 1024)} MB`;
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} GB`;
}

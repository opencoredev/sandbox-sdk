/** Status board states and how they look. No data imports, so the client grid can use it. */

export const cellStates = ["ok", "some", "many", "limit", "none"] as const;
export type CellState = (typeof cellStates)[number];

/** How each state looks on the board and in its legend. */
export const stateLook = {
  ok: { label: "All succeeded", className: "bg-[var(--ok)]" },
  some: { label: "Under 5% failed", className: "bg-[var(--warn)]" },
  many: { label: "5% or more failed", className: "bg-[var(--bad)]" },
  limit: { label: "Stopped by our plan's limit", className: "bg-[repeating-linear-gradient(135deg,var(--muted)_0_2px,transparent_2px_5px)]" },
  none: { label: "Not supported or not run", className: "border border-dashed border-[var(--muted)]" },
} as const satisfies Record<CellState, { label: string; className: string }>;

export interface Cell {
  id: string;
  name: string;
  state: CellState;
  text: string;
  succeeded: number;
  attempts: number;
}

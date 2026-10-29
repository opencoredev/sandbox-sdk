/** The Sandbox SDK scope mark in brand amber: four corner brackets framing one lit cell. Same paths as apps/web. */
export function Mark() {
  return (
    <svg className="size-4.5 text-brand" viewBox="0 0 32 32" aria-hidden="true">
      <path
        fill="currentColor"
        d="M2 2h10v4H6v6H2zM30 2v10h-4V6h-6V2zM2 30V20h4v6h6v4zM30 30H20v-4h6v-6h4zM12 12h8v8h-8z"
      />
    </svg>
  );
}

/** Mark plus wordmark, sized to the header. */
export function Lockup() {
  return (
    <span className="flex items-center gap-2.5 text-lockup font-semibold tracking-tight whitespace-nowrap">
      <Mark />
      <span>
        Sandbox <span className="font-normal text-muted">bench</span>
      </span>
    </span>
  );
}

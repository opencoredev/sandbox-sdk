import type { SVGProps } from "react";

export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      focusable="false"
      viewBox="0 0 172 110"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M20 2h150v40H54v20H16L2 50V18L20 2Z" fill="currentColor" />
      <path d="M2 72h122V52h32l14 14v28l-14 14H2V72Z" fill="currentColor" />
      <path d="M64 50h52v16H64V50Z" fill="#42CBB7" />
    </svg>
  );
}

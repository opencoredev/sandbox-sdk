import "react";

declare module "react" {
  /** Dynamic values reach the page as CSS custom properties, read by classes such as `h-(--bar)`. */
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}

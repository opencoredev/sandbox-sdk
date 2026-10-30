import "react";

declare module "react" {
  /** Custom properties (`--x`), the one kind of inline style the lint allows, for values CSS reads with var(). */
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}

import { GeistMono } from "geist/font/mono";
import { GeistPixelSquare } from "geist/font/pixel";
import { GeistSans } from "geist/font/sans";

/** CSS variables for the landing page's type: --font-geist-sans, --font-geist-mono, --font-geist-pixel-square. */
export const fontVariables = [
  GeistSans.variable,
  GeistMono.variable,
  GeistPixelSquare.variable,
].join(" ");

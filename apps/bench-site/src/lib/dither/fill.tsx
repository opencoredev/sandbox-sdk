import type { ComponentProps, CSSProperties, ReactNode } from "react";

import type { DitherMatrix } from "@/lib/dither/matrices";
import { DitherPattern } from "@/lib/dither/pattern";
import { bloomFilter, bloomLayer, ditherRamp, fillPaint, fillTile } from "@/lib/dither/style";
import type { Bloom, FillEdge, FillStyleOptions, FillVariant } from "@/lib/dither/style";
import { cssColor } from "@/lib/dither/tokens";
import type { DitherColor } from "@/lib/dither/tokens";

/**
 * SVG and DOM pieces of the style kit: a pattern for every fill variant
 * and two ways to draw bloom. Server-safe.
 */

/** Where a gradient fill's dense edge sits, in SVG user units. */
export interface FillRamp {
  /** The dense side. */
  edge: FillEdge;
  /** Coordinate of that side: y for `top`/`bottom`, x for `left`/`right`. */
  at: number;
  /** How far the fade runs from the edge. */
  length: number;
  /** How far the fill reaches past the edge in total. Default `length`. Past the fade it holds `floor`. */
  extent?: number;
}

export interface FillPatternProps {
  /** The id to reference, as in `fill="url(#id)"`. */
  id: string;
  /** The texture. */
  fill: FillVariant;
  /** Colour: a palette name or any CSS colour. Default `ink`. */
  color?: DitherColor;
  /** Cell size in SVG user units. Default 3. */
  cell?: number;
  /** Gradient only: coverage at the dense edge, 0 to 1. Default 1. */
  level?: number;
  /** Gradient only: coverage at the far end of the fade. Default 0.0625. */
  floor?: number;
  /** Gradient only: threshold matrix. Default `bayer4`. */
  matrix?: DitherMatrix;
  /** Gradient only: where the dense edge sits. Without it, a gradient fills one even `level`. */
  ramp?: FillRamp;
}

/**
 * An SVG `<pattern>` for any fill variant. Place it inside `<defs>` and
 * fill shapes with `url(#id)`. To reuse one ramp at several positions (one
 * per bar), reference it with `<pattern id="b2" href="#id" y={top} />`.
 */
export const FillPattern = ({
  id,
  fill,
  color = "ink",
  cell = 3,
  level = 1,
  floor = 0.0625,
  matrix = "bayer4",
  ramp,
}: FillPatternProps) => {
  const ink = cssColor(color);

  if (fill === "solid") {
    return (
      <pattern id={id} width={cell} height={cell} patternUnits="userSpaceOnUse">
        <rect width={cell} height={cell} fill={ink} />
      </pattern>
    );
  }

  if (fill === "dotted" || fill === "hatched") {
    const { size, path } = fillTile(fill);

    return (
      <pattern
        id={id}
        width={size * cell}
        height={size * cell}
        patternUnits="userSpaceOnUse"
        className="crisp-edges"
      >
        <path d={path} transform={`scale(${cell})`} fill={ink} />
      </pattern>
    );
  }

  if (ramp === undefined) {
    return <DitherPattern id={id} level={level} matrix={matrix} cell={cell} color={color} />;
  }

  const tile = ditherRamp({
    edge: ramp.edge,
    extent: (ramp.extent ?? ramp.length) / cell,
    from: level,
    length: ramp.length / cell,
    matrix,
    to: floor,
  });

  const width = tile.width * cell;
  const height = tile.height * cell;

  const origin = {
    bottom: { x: 0, y: ramp.at - height },
    left: { x: ramp.at, y: 0 },
    right: { x: ramp.at - width, y: 0 },
    top: { x: 0, y: ramp.at },
  }[ramp.edge];

  return (
    <pattern
      id={id}
      x={origin.x}
      y={origin.y}
      width={width}
      height={height}
      patternUnits="userSpaceOnUse"
      className="crisp-edges"
    >
      <path d={tile.path} transform={`scale(${cell})`} fill={ink} />
    </pattern>
  );
};

export interface BloomGroupProps extends ComponentProps<"g"> {
  bloom: Bloom;
}

/**
 * An SVG group drawn as a glow: put solid copies of your shapes inside
 * and render it before (under) the real fills. Renders nothing when off.
 */
export const BloomGroup = ({ bloom, className, style, ...props }: BloomGroupProps) => {
  const layer = bloomLayer(bloom);

  return layer === undefined ? null : (
    <g
      aria-hidden="true"
      {...props}
      className={`filter-(--bloom-filter) opacity-(--bloom-opacity) ${className ?? ""}`}
      style={{ "--bloom-filter": layer.blur, "--bloom-opacity": layer.opacity, ...style }}
    />
  );
};

export type BloomBoxProps = ComponentProps<"div"> & {
  /** Glow colour: a palette name or any CSS colour. Default `ink`. */
  color?: DitherColor;
  bloom: Bloom;
};

/**
 * A wrapper that glows around whatever it holds, in `color`. A CSS
 * drop-shadow, so it follows dithered cells and transparent gaps.
 */
export const BloomBox = ({ color = "ink", bloom, className, style, ...props }: BloomBoxProps) => (
  <div
    {...props}
    className={`filter-(--bloom-filter) ${className ?? ""}`}
    style={{ "--bloom-filter": bloomFilter(color, bloom) ?? "none", ...style }}
  />
);

export type DitherFillProps = FillStyleOptions & {
  variant: FillVariant;
  /** The element to paint. Default `div`. */
  as?: "div" | "span";
  className?: string;
  /** Custom properties for the classes in `className`, such as a height. */
  style?: CSSProperties;
  "aria-hidden"?: boolean;
  children?: ReactNode;
};

/**
 * An element painted with a fill variant through the `dither-fill` utility.
 * It needs a size; children are masked too, so put content in a sibling.
 */
export const DitherFill = ({
  variant,
  as: Element = "div",
  className,
  style,
  "aria-hidden": ariaHidden,
  children,
  ...options
}: DitherFillProps) => {
  const paint = fillPaint(variant, options);

  return (
    <Element
      aria-hidden={ariaHidden}
      className={`dither-fill ${className ?? ""}`}
      style={{
        ...style,
        "--fill-color": paint.color,
        "--fill-mask": paint.mask,
        "--fill-mask-position": paint.position,
        "--fill-mask-repeat": paint.repeat,
        "--fill-mask-size": paint.size,
      }}
    >
      {children}
    </Element>
  );
};

"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

import { ProviderLogo } from "@/components/docs-icon";
import { HalftoneCanvas, type FrameInfo } from "@/components/halftone/halftone-canvas";
import type { HalftoneStyle } from "@/components/halftone/halftone";
import {
  HARBOR_PROVIDERS,
  harborCargo,
  paintHarbor,
  type CargoMark,
} from "@/components/harbor/paint";

import styles from "./landing.module.css";

type HarborProvider = (typeof HARBOR_PROVIDERS)[number];

/** The SDK factory each provider is created with, as it appears in code. */
const FACTORY: Record<HarborProvider["id"], string> = {
  e2b: "e2b()",
  daytona: "daytona()",
  vercel: "vercel()",
  upstash: "upstash()",
  box: "box()",
  railway: "railway()",
  tenki: "tenki()",
  local: "local()",
};

const MAX_LANDED = 6;

/** Place a label centred above a container, kept inside the frame. */
function place(el: HTMLElement, mark: CargoMark, width: number, gap: number) {
  const x = Math.min(Math.max(mark.x - el.offsetWidth / 2, 4), width - el.offsetWidth - 4);
  const y = Math.max(mark.y - el.offsetHeight - gap, 4);
  el.style.opacity = mark.opacity.toFixed(3);
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}

/**
 * The hero harbor. The crane brings in one provider's sandbox at a time and an
 * agent gets to work inside it (drawn in the scene). The carried container
 * wears a tag with its SDK call; each landed one keeps a logo chip.
 */
export function HarborViewport({ style, brackets }: { style: HalftoneStyle; brackets: ReactNode }) {
  const tag = useRef<HTMLDivElement>(null);
  const chips = useRef<(HTMLDivElement | null)[]>([]);
  const [carried, setCarried] = useState<HarborProvider>(HARBOR_PROVIDERS[0]);
  const [landed, setLanded] = useState<HarborProvider[]>([]);
  const shown = useRef({ carried: "", landed: "" });

  const follow = useCallback(({ t, look, width, height }: FrameInfo) => {
    const cargo = harborCargo(width, height, t, look);
    const el = tag.current;
    if (el) {
      if (cargo.carried) place(el, cargo.carried, width, 16);
      else el.style.opacity = "0";
    }
    cargo.landed.forEach((mark, i) => {
      const chip = chips.current[i];
      if (!chip) return;
      place(chip, mark, width, 8);
    });
    for (let i = cargo.landed.length; i < MAX_LANDED; i++) {
      const chip = chips.current[i];
      if (chip) chip.style.opacity = "0";
    }
    const carriedId = cargo.carried?.provider.id ?? shown.current.carried;
    const landedIds = cargo.landed.map((m) => m.provider.id).join(",");
    // re-render only when what is on show changes, not every frame
    if (carriedId !== shown.current.carried || landedIds !== shown.current.landed) {
      shown.current = { carried: carriedId, landed: landedIds };
      if (cargo.carried) setCarried(cargo.carried.provider);
      setLanded(cargo.landed.map((m) => m.provider));
    }
  }, []);

  return (
    <div className={styles.viewport} data-reveal aria-hidden="true">
      <HalftoneCanvas
        paint={paintHarbor}
        style={style}
        fps={30}
        stillAt={9.5}
        onFrame={follow}
        className={styles.viewportCanvas}
      />
      {Array.from({ length: MAX_LANDED }, (_, i) => (
        <div
          key={i}
          ref={(el) => {
            chips.current[i] = el;
          }}
          className={styles.cargoChip}
          style={{ opacity: 0 }}
        >
          {landed[i] && <ProviderLogo id={landed[i].id} />}
        </div>
      ))}
      <div ref={tag} className={styles.cargoTag} style={{ opacity: 0 }}>
        <ProviderLogo id={carried.id} />
        <span>{carried.name}</span>
        <span>{FACTORY[carried.id]}</span>
      </div>
      {brackets}
    </div>
  );
}

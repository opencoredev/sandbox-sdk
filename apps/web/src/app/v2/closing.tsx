"use client";

import { HalftoneCanvas } from "@/components/halftone/halftone-canvas";
import { emberField } from "@/components/halftone/painters";

import landing from "../(home)/landing.module.css";
import { CopyCommand } from "../(home)/parts";
import { EMBER_DOTS, INSTALL } from "../(home)/site";
import { Actions } from "./actions";
import styles from "./v2.module.css";

/** The closing call to action over the ember halftone. A client component, since the canvas takes a paint function. */
export function Closing() {
  return (
    <section className={landing.closing} aria-labelledby="closing-title">
      <HalftoneCanvas
        paint={emberField}
        style={EMBER_DOTS}
        fps={15}
        stillAt={2}
        className={landing.closingCanvas}
      />
      <div className={landing.closingText}>
        <h2 id="closing-title" className={styles.title}>
          Start in one install.
        </h2>
        <CopyCommand command={INSTALL} />
        <Actions />
      </div>
    </section>
  );
}

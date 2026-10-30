import landing from "../(home)/landing.module.css";
import { DocsButton } from "../(home)/parts";
import { CopyPrompt } from "./copy-prompt";

/** Read the docs, or hand the setup to a coding agent. */
export function Actions() {
  return (
    <div className={landing.heroActions}>
      <DocsButton />
      <CopyPrompt />
    </div>
  );
}

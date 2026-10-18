import { modelSpec } from "../lib/model";
import { providerName } from "../lib/sandbox";
import { Builder } from "./builder";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Builder provider={providerName} model={modelSpec} />;
}

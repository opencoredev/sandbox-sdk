import { createDaytonaProvider, type DaytonaOptions, type DaytonaProvider } from "./provider.js";

export type { DaytonaCapability, DaytonaOptions, DaytonaProvider } from "./provider.js";

/** Direct Daytona adapter. The optional SDK is loaded only on first operation. */
export function daytona(options: DaytonaOptions = {}): DaytonaProvider {
  return createDaytonaProvider(options, () => import("@daytonaio/sdk"));
}

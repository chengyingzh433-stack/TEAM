import { join } from "node:path";

/** Product branding must not change the location of existing research or UI state. */
export function teamUserDataDirectory(appData: string, override?: string): string {
  return override?.trim() || join(appData, "Lancer");
}

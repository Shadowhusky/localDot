import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// apps/daemon/src → apps/web/<sub>; fileURLToPath keeps the apostrophe in the repo path intact.
export function webDir(sub: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", sub);
}

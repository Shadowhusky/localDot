import { statfsSync } from "node:fs";
export function freeBytes(dir: string): number {
  try {
    const stat = statfsSync(dir);
    const bytes = stat.bavail * stat.bsize;
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : 0;
  } catch {
    return 0;
  }
}

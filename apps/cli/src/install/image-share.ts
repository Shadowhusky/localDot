import { IMAGE_ROLES } from "../../../../packages/protocol/src/release.ts";
import type { ImagePreparationProgress } from "./prepare-images.ts";

const PHASES = ["checking", "ready", "pulling", "downloading", "extracting", "verifying"];
// Docker names each layer it pulls; more than this and the rest go uncounted.
const MAX_LAYERS = 512;

export interface ImageShare {
  // The share of all four images on disk, 0 to 1. It never goes back.
  share: number;
  // Bytes of the layers being downloaded: done, and known so far.
  done: number;
  total: number;
}

/** Turns image preparation reports into one share of the whole. Each image counts a quarter,
 * whatever its size; a report it can't place returns undefined. */
export function imageShare() {
  // Downloaded and total bytes per image and layer.
  const layers = new Map<string, { current: number; total: number }>();
  const ready = new Set<string>();
  let progress = 0;
  const share = () => {
    let sum = 0;
    for (const role of IMAGE_ROLES) {
      if (ready.has(role)) {
        sum += 1;
        continue;
      }
      let current = 0,
        total = 0;
      for (const [key, bytes] of layers) {
        if (!key.startsWith(`${role} `)) continue;
        current += bytes.current;
        total += bytes.total;
      }
      if (total > 0) sum += current / total;
    }
    return Math.floor((sum / IMAGE_ROLES.length) * 1000) / 1000;
  };
  return (report: ImagePreparationProgress): ImageShare | undefined => {
    if (!IMAGE_ROLES.includes(report.role) || !PHASES.includes(report.phase)) return;
    const { role, phase, layer, currentBytes, totalBytes } = report;
    if (phase === "ready") ready.add(role);
    const key = `${role} ${layer ?? ""}`;
    const known = layers.get(key);
    if (known || layers.size < MAX_LAYERS) {
      if (
        phase === "downloading" &&
        Number.isSafeInteger(currentBytes) &&
        Number.isSafeInteger(totalBytes) &&
        currentBytes !== undefined &&
        totalBytes !== undefined &&
        currentBytes >= 0 &&
        totalBytes >= currentBytes
      )
        layers.set(key, { current: currentBytes, total: totalBytes });
      else if (known && (phase === "verifying" || phase === "extracting"))
        known.current = known.total;
    }
    progress = Math.max(progress, share());
    let done = 0,
      total = 0;
    for (const bytes of layers.values()) {
      done += bytes.current;
      total += bytes.total;
    }
    return { share: progress, done, total };
  };
}

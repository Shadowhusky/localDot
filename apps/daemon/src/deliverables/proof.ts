import type { ProofFrame, ResultProof } from "@localdot/protocol";
import type { ScannedFrame, ScannedResult } from "./task-scan.ts";

// Start and end are the first and last screenshots of the turn. The key change is a middle
// screenshot: the first one taken after the largest file change, else the one in the step whose
// screen changed most, else the middle one.
export function pickProofFrames(
  result: ScannedResult,
  exists: (frameId: string) => boolean,
): ProofFrame[] {
  const frames = result.frames.filter((f) => exists(f.frameId));
  const start = frames[0];
  const end = frames.at(-1);
  if (!start || !end) return [];
  if (frames.length === 1) return [frame("start", start)];
  if (frames.length === 2) return [frame("start", start), frame("end", end)];
  const middle = frames.slice(1, -1);
  const change =
    afterLargestChange(result, middle) ??
    inBusiestStep(result, middle) ??
    (middle[Math.floor((middle.length - 1) / 2)] as ScannedFrame);
  return [frame("start", start), frame("change", change), frame("end", end)];
}
function frame(role: ProofFrame["role"], f: ScannedFrame): ProofFrame {
  return { role, frameId: f.frameId, tMs: f.tMs };
}
function afterLargestChange(
  result: ScannedResult,
  middle: ScannedFrame[],
): ScannedFrame | undefined {
  let best: { size: number; seq: number } | undefined;
  for (const change of result.changes.values())
    if (!best || change.size >= best.size) best = change;
  if (!best) return undefined;
  const seq = best.seq;
  return middle.find((f) => f.seq > seq);
}
function inBusiestStep(result: ScannedResult, middle: ScannedFrame[]): ScannedFrame | undefined {
  let best: [string, number] | undefined;
  for (const entry of result.settles)
    if (entry[1] > 0 && (!best || entry[1] > best[1])) best = entry;
  const step = best?.[0];
  return step === undefined ? undefined : middle.find((f) => f.step === step);
}

export function resultProof(
  result: ScannedResult,
  exists: (frameId: string) => boolean,
): ResultProof {
  return {
    resultId: result.id,
    frames: pickProofFrames(result, exists),
    checked: result.checked ? [...result.checked].slice(0, 200).join("") : null,
    startMs: result.startMs,
    endMs: result.tMs,
  };
}

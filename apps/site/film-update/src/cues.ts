import cues from "../cues.json";

// The film's timing, shared with its soundtrack (score.py) and the takes of the app (capture/): one
// bar is two seconds at 120 bpm.
export const CUES = cues as {
  bpm: number;
  length: number;
  marks: Record<keyof typeof cues.marks, number>;
};
export const M = CUES.marks;
export const BEAT = 60 / CUES.bpm;

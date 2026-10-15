import type { PersonaId } from "@localdot/protocol";
import cues from "../../film/cues.json";

// The film's timing, shared with its soundtrack (film/score.py): one bar is two seconds at 120 bpm.
export type Mark =
  | "land"
  | "hello"
  | "own"
  | "screen"
  | "watch"
  | "montage"
  | "step"
  | "take"
  | "handBack"
  | "models"
  | "jobs"
  | "lineup"
  | "smile"
  | "rewind"
  | "replay"
  | "share"
  | "save"
  | "saved"
  | "yours"
  | "pin"
  | "end"
  | "hit";

// A demo in the montage: when it comes in, and dot's line naming it. Its clip is in film/index.html.
export interface Cut {
  at: number;
  line: string;
}

export interface Cues {
  bpm: number;
  length: number;
  marks: Record<Mark, number>;
  montage: Cut[];
  // The recording the app shows from Step in until it leaves for the models, and where it starts.
  work: { demo: string; from: number };
  outfits: { at: number; persona: PersonaId }[];
}

export const CUES = cues as Cues;
export const M = CUES.marks;
export const BEAT = 60 / CUES.bpm;

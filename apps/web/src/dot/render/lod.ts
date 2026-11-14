import type { Lod } from "../engine/states.ts";

export function lodFor(cssSize: number): Lod {
  if (cssSize <= 18) return "glyph";
  if (cssSize <= 32) return "badge";
  if (cssSize <= 72) return "presence";
  if (cssSize <= 144) return "glance";
  return "hero";
}

export interface LodDetail {
  // Eyes grow and lid tilt is exaggerated at small sizes, so worried and annoyed still separate.
  eyeScale: number;
  tiltGain: number;
  // Eye centres snap to half device pixels and the body to whole ones, so a still badge stays crisp.
  snap: boolean;
  // A soft reflection of the key light in each eye and a shaded eye fill.
  gloss: boolean;
  shadow: boolean;
  // The longest a calm view waits between renders. Breathing reads as still at about 9 fps, and a
  // calm dot is on screen for the whole of a task.
  calmGapMs: number;
  // The longest it waits between renders while a prop's loops (a caret, a sweep) run: 20 fps
  // reads as smooth at the dock's size, and a task keeps a prop out most of the time.
  loopGapMs: number;
  // On a touch device, the longest it waits between renders while it moves quickly (0: every
  // frame). A dot this small looks as smooth at half the display rate, and a phone that draws it
  // on every frame through a long task grows warm.
  touchQuickGapMs: number;
}

const BADGE: LodDetail = {
  eyeScale: 1.25,
  tiltGain: 1.6,
  snap: true,
  gloss: false,
  shadow: false,
  calmGapMs: 250,
  loopGapMs: 33,
  touchQuickGapMs: 33,
};
const GLANCE: LodDetail = {
  eyeScale: 1,
  tiltGain: 1,
  snap: false,
  gloss: true,
  shadow: true,
  calmGapMs: 110,
  loopGapMs: 33,
  touchQuickGapMs: 0,
};

// A glyph-sized live view draws like a badge; Dot shows the static Glyph there instead.
export const LOD_DETAIL: Record<Lod, LodDetail> = {
  glyph: BADGE,
  badge: BADGE,
  presence: { ...GLANCE, gloss: false, shadow: false, loopGapMs: 50, touchQuickGapMs: 33 },
  glance: GLANCE,
  hero: GLANCE,
};

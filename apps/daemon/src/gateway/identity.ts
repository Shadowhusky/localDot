import type { Point, Rect, Target } from "@localdot/protocol";

export interface NativeActionIdentity {
  readonly target: Target | null;
  readonly window: number | null;
  readonly point: Point | null;
  // With the window id, all a lookup that ran out of time knows.
  readonly windowFrame?: Rect;
  readonly unknown?: true;
  // A drag's other end: what is under its drop point.
  readonly drop?: Omit<NativeActionIdentity, "drop">;
}

// Toolkits round their own layout: two reads of one element can differ by a pixel.
const SLACK_PX = 2;
const BOUND: readonly (keyof Target)[] = [
  "source",
  "role",
  "name",
  "app",
  "window",
  "url",
  "secret",
  "editable",
  "mark",
];

const near = (a: number, b: number) => Math.abs(a - b) <= SLACK_PX;
const sameRect = (a: Rect | undefined, b: Rect | undefined) =>
  !a || !b ? a === b : near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
const samePoint = (a: Point | null, b: Point | null) =>
  !a || !b ? a === b : near(a.x, b.x) && near(a.y, b.y);

// Target identity is the desktop's own accessibility result, never an untrusted model label.
export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b) return a === b;
  return (
    BOUND.every((key) => a[key] === b[key]) &&
    samePoint(a.point, b.point) &&
    sameRect(a.bbox, b.bbox)
  );
}

// `approved` is the read an approval (or a freshness basis) was made on, `fresh` a later read of
// the same action. Window and frame always bind. An approval made on a read that ran out of time,
// or on keyboard focus that was on no element yet, knew only the window, so that is all it binds
// short of a secret field (the permit classifies any other element the fresh read found); one made
// on an element is never confirmed by a read that ran out of time.
export function sameNativeIdentity(
  approved: NativeActionIdentity,
  fresh: NativeActionIdentity,
): boolean {
  if (approved.drop || fresh.drop) {
    if (!approved.drop || !fresh.drop || !sameNativeIdentity(approved.drop, fresh.drop))
      return false;
  }
  if (approved.window !== fresh.window || !sameRect(approved.windowFrame, fresh.windowFrame))
    return false;
  if (approved.unknown || approved.target === null) return fresh.target?.secret !== true;
  if (fresh.unknown) return false;
  return samePoint(approved.point, fresh.point) && sameTarget(approved.target, fresh.target);
}

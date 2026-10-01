import { type AvatarParams, NEUTRAL_PARAMS } from "@localdot/avatar";

export interface SheetPose {
  label: string;
  params: AvatarParams;
}

const pose = (label: string, overrides: Partial<AvatarParams>): SheetPose => ({
  label,
  params: { ...NEUTRAL_PARAMS, ...overrides },
});

export const SHEET_POSES: SheetPose[] = [
  ...[1, 0, -1].flatMap((y) =>
    [-1, 0, 1].map((x) => pose(`head ${x},${y}`, { headX: x, headY: y, eyeX: x, eyeY: y })),
  ),
  pose("eyes open", {}),
  pose("eyes half", { eyeOpenL: 0.5, eyeOpenR: 0.5 }),
  pose("eyes closed", { eyeOpenL: 0, eyeOpenR: 0 }),
  pose("eyes smile", { expressions: { smile: 1 } }),
  pose("wink", { eyeOpenR: 0 }),
  ...(["A", "I", "U", "E", "O", "N"] as const).map((m) =>
    pose(`mouth ${m}`, { mouthShape: m, mouthOpen: 1 }),
  ),
  pose("mouth smile", { expressions: { smile: 1 } }),
  pose("mouth rest", {}),
  pose("smug", { expressions: { smug: 1 } }),
  pose("annoyed", { headX: 0.35, bodyX: 0.25, expressions: { annoyed: 1 } }),
  pose("blush", { blush: 1 }),
  pose("surprised", { brow: 0.8 }),
  pose("worried", { brow: -0.4, eyeOpenL: 0.8, eyeOpenR: 0.8 }),
  pose("lean left", { bodyX: -1 }),
  pose("lean right", { bodyX: 1 }),
  pose("breath in", { breath: 1 }),
];

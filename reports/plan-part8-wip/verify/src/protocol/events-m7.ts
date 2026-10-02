import { z } from "zod";
import { ULID_PATTERN } from "./ids.ts";
import { DownloadKind } from "./quarantine.ts";
import { ScreenName, ScreenSwitchData } from "./screens.ts";

const envelope = {
  v: z.literal(1),
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  t: z.number().int().nonnegative(),
  agent: z.string().min(1),
  step: z.string().min(1).optional(),
};
const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ ...envelope, type: z.literal(type), data });

const id = z.string().regex(ULID_PATTERN);

export const ScreenSwitch = event("screen.switch", ScreenSwitchData);
export const DownloadQuarantined = event(
  "download.quarantined",
  z.object({
    downloadId: id,
    name: z.string().min(1).max(130),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: DownloadKind,
    source: z.string().max(253),
  }),
);
export const DownloadReleased = event(
  "download.released",
  z.object({
    downloadId: id,
    to: z.enum(["computer", "mac"]),
    path: z.string().max(1024).optional(),
  }),
);
export const DownloadDiscarded = event(
  "download.discarded",
  z.object({ downloadId: id, by: z.enum(["user", "expiry"]) }),
);
export const DownloadRefused = event(
  "download.refused",
  z.object({
    name: z.string().min(1).max(130),
    reason: z.enum(["too-large", "quarantine-full", "failed"]),
    bytes: z.number().int().nonnegative().optional(),
    source: z.string().max(253),
  }),
);
// Part 2's control.change gains the screen the holder controls (absent: the desktop).
export const ControlChange = event(
  "control.change",
  z.object({
    holder: z.enum(["agent", "user"]),
    reason: z.enum(["user_takeover", "handoff_request", "resume"]),
    screen: ScreenName.optional(),
  }),
);

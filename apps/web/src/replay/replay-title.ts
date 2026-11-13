import type { SessionVerdict } from "@localdot/protocol";
import { t } from "../i18n/index.ts";

// Below a laptop the library has no room for its preview, so a row opens its recording at once.
// Wide enough for the chosen recording beside the list.
export const PREVIEW_ROOM = "(width >= 1100px)";

export const RECORDED_TASK = t`Recorded task`;

// What the player shows of the recording on show, for the bar above it.
export interface RecordedTitle {
  sessionId: string;
  title: string;
  note: string;
  verdict: SessionVerdict;
}

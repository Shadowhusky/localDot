import { seedDraw } from "@localdot/protocol";
import { useMemo } from "react";
import {
  type ConversationRow,
  conversationLook,
  lookSeed,
  STATUS_LABEL,
} from "../agent/conversation-list.ts";
import { Dot } from "../dot/Dot.tsx";
import { DotAvatar } from "../dot/DotAvatar.tsx";
import type { DotState } from "../dot/engine/states.ts";
import { markOf, TagMark } from "../ui/ConversationTag.tsx";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";

// A conversation under way moves: at a badge's size that is a blink now and then.
const LIVE_STATE: Partial<Record<ConversationRow["status"], DotState>> = {
  working: "thinking",
  "needs-you": "your-turn",
};

// A conversation's mark in a list: its dot, dressed as this conversation alone is, with its status
// on a badge at the corner and, at the row's edge, its colour tag.
export function ConversationAvatar({
  row,
  size = 32,
  tagged = true,
  labelled = false,
  badged = true,
}: {
  row: ConversationRow;
  size?: number;
  // Off where the card holding it draws the tag at its own edge.
  tagged?: boolean;
  // The status spoken here; off where the row's own name says it.
  labelled?: boolean;
  // Off where the row shows its status at its own edge; an amber point still says it needs you.
  badged?: boolean;
}) {
  const look = conversationLook(row.entry);
  const seed = lookSeed(row.entry);
  const key = look.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the outfit's words say when it changed.
  const wearables = useMemo(() => look, [key]);
  const live = LIVE_STATE[row.status];
  return (
    <span className="conversation-avatar" data-size={size}>
      {live ? (
        <Dot
          size={size}
          state={live}
          wearables={wearables}
          control={!badged && row.status === "working" && !!row.entry.live?.onScreen}
          seed={Math.floor(seedDraw(seed, "moves") * 2 ** 31)}
        />
      ) : (
        <DotAvatar size={size} wearables={wearables} seed={seed} />
      )}
      {badged ? (
        <span className="conversation-avatar-status">
          <SessionGlyph
            status={row.status}
            size={12}
            {...(labelled ? { label: STATUS_LABEL[row.status] } : {})}
          />
        </span>
      ) : (
        row.status === "needs-you" && <span className="conversation-avatar-point" />
      )}
      {tagged && <TagMark tag={markOf(row.entry)} />}
    </span>
  );
}

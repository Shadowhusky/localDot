import { useId, useMemo } from "react";
import {
  type ConversationRow,
  conversationRows,
  type LiveFacts,
  liveConversations,
  useRecentConversations,
} from "../agent/conversation-list.ts";
import type { ApiClient } from "../lib/api.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import "../ui/conversation-switcher.css";

// The ring's radius in its 40-unit box, and the room between two arcs.
const RADIUS = 18;
const GAP = 5;

export interface ConversationsBubbleProps {
  api: ApiClient;
  facts: LiveFacts;
  // The conversation on show, which the island already speaks for.
  current: string | null;
  // One of the others waits on the user.
  attention: boolean;
  onOpen(): void;
}

// "2 others under way, 1 needs you": what the ring says to a screen reader.
export function underWayElsewhere(rows: readonly ConversationRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  const asking = rows.filter((row) => row.status === "needs-you").length;
  const others = rows.length === 1 ? "1 other under way" : `${rows.length} others under way`;
  return asking ? `${others}, ${asking} needs you` : others;
}

// A phone's way to its conversations, in the corner over the picture. While others are under way
// a ring of arcs, one for each in its status's colour, sits around it: at a glance, how many are
// at work and whether one is waiting on the user, before anything is opened.
export function ConversationsBubble({
  api,
  facts,
  current,
  attention,
  onOpen,
}: ConversationsBubbleProps) {
  const recent = useRecentConversations(api, true);
  const others = useMemo(
    () =>
      liveConversations(conversationRows(recent.entries, facts)).filter(
        (row) => row.entry.sessionId !== current,
      ),
    [recent.entries, facts, current],
  );
  const summaryId = useId();
  const summary = underWayElsewhere(others);
  const circumference = 2 * Math.PI * RADIUS;
  const arc = others.length ? circumference / others.length : 0;
  return (
    <span className="conversations-bubble">
      <IconButton
        icon="message-circle"
        size={32}
        variant="filled"
        round
        label="Conversations"
        attention={attention}
        aria-describedby={summary ? summaryId : undefined}
        onClick={onOpen}
      />
      {others.length > 0 && (
        <svg className="conversations-ring" viewBox="0 0 40 40" aria-hidden="true">
          {others.map((row, index) => (
            <circle
              key={row.entry.sessionId}
              cx="20"
              cy="20"
              r={RADIUS}
              data-status={row.status}
              strokeDasharray={`${Math.max(arc - (others.length > 1 ? GAP : 0), 1)} ${circumference}`}
              strokeDashoffset={-index * arc}
            />
          ))}
        </svg>
      )}
      {summary && <VisuallyHidden id={summaryId}>{summary}</VisuallyHidden>}
    </span>
  );
}

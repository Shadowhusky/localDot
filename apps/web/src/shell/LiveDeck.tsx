import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type ConversationRow, STATUS_LABEL } from "../agent/conversation-list.ts";
import { Button } from "../ui/Button.tsx";
import { TagMark } from "../ui/ConversationTag.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { attachLongPress } from "../ui/long-press.ts";
import { triggerProps } from "../ui/Popover.tsx";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";
import { conversationLabel } from "./SessionRail.tsx";
import "../ui/conversation-switcher.css";

export interface LiveDeckProps {
  // The conversations under way, most urgent first.
  rows: readonly ConversationRow[];
  current: string | null;
  now: Date;
  // Why another conversation can't be taken up now.
  reason?: string;
  // The one whose menu is open.
  menuFor?: string;
  // The one whose name is being typed, in the field given for it.
  renaming?: string;
  renameField(row: ConversationRow): ReactNode;
  onPick(row: ConversationRow): void;
  onMenu(row: ConversationRow, trigger: HTMLElement): void;
  // Touched and held: the card grows into its preview.
  onPeek(row: ConversationRow, card: HTMLElement): void;
}

// The phone's conversations under way as a row of cards, as Live Activities show what is going on:
// what each is doing, in its own words, and whether it needs the user, a tap from being taken up.
// It scrolls sideways, a card at a time, and the cards coming in from the edge grow as they come.
export function LiveDeck({
  rows,
  current,
  now,
  reason,
  menuFor,
  renaming,
  renameField,
  onPick,
  onMenu,
  onPeek,
}: LiveDeckProps) {
  const heading = useId();
  return (
    <section className="live-deck" aria-labelledby={heading}>
      <div id={heading} className="conversations-day live-deck-head">
        Under way <span className="live-deck-count num">{rows.length}</span>
      </div>
      <ul className="live-deck-cards" data-count={Math.min(rows.length, 3)}>
        {rows.map((row) => (
          <LiveCard
            key={row.entry.sessionId}
            row={row}
            now={now}
            current={row.entry.sessionId === current}
            blocked={reason && row.entry.sessionId !== current ? reason : undefined}
            menuOpen={menuFor === row.entry.sessionId}
            rename={renaming === row.entry.sessionId ? renameField(row) : undefined}
            onPick={() => onPick(row)}
            onMenu={(trigger) => onMenu(row, trigger)}
            onPeek={(card) => onPeek(row, card)}
          />
        ))}
      </ul>
    </section>
  );
}

// A card's own word for a status too long for its first line.
const CARD_WORD: Partial<Record<ConversationRow["status"], string>> = { waiting: "Waiting" };

const STATUS_LINE: Partial<Record<ConversationRow["status"], string>> = {
  "needs-you": "Waiting for your answer",
  waiting: "Waits for its turn on the computer",
  idle: "Ready for your next message",
};

// A line under the title: what dot is doing, or what the conversation waits for, or else what was
// first asked when the name is not already that.
function cardLine(row: ConversationRow): string | undefined {
  if (row.activity) return row.activity;
  const line = STATUS_LINE[row.status];
  if (line) return line;
  const said = row.entry.said?.trim();
  return said && said !== row.title ? said : undefined;
}

function LiveCard({
  row,
  now,
  current,
  blocked,
  menuOpen,
  rename,
  onPick,
  onMenu,
  onPeek,
}: {
  row: ConversationRow;
  now: Date;
  current: boolean;
  blocked?: string;
  menuOpen: boolean;
  rename?: ReactNode;
  onPick(): void;
  onMenu(trigger: HTMLElement): void;
  onPeek(card: HTMLElement): void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [holding, setHolding] = useState(false);
  const peek = useRef(onPeek);
  peek.current = onPeek;
  useEffect(() => {
    const element = card.current;
    if (!element) return;
    return attachLongPress(element, {
      pressing: setHolding,
      hold: () => peek.current(element),
    });
  }, []);
  const line = cardLine(row);
  const lineId = useId();
  return (
    <li className="live-card" data-flip={row.entry.sessionId}>
      <div
        ref={card}
        className="live-card-body"
        data-status={row.status}
        data-current={current || undefined}
        data-holding={holding || undefined}
        data-menu={menuOpen || undefined}
      >
        {rename ? (
          <div className="live-card-rename">{rename}</div>
        ) : (
          <Button
            variant="quiet"
            className="live-card-open"
            aria-label={conversationLabel(row, now)}
            aria-current={current || undefined}
            aria-describedby={line ? lineId : undefined}
            disabledReason={blocked}
            onClick={onPick}
          >
            <span className="live-card-state">
              <SessionGlyph status={row.status} />
              <span className="live-card-word">
                {CARD_WORD[row.status] ?? STATUS_LABEL[row.status]}
              </span>
              {row.entry.live?.onScreen && <Icon name="monitor" size={12} />}
            </span>
            <span className="live-card-title">{row.title}</span>
            {line && (
              <span id={lineId} className="live-card-line">
                {line}
              </span>
            )}
          </Button>
        )}
        <TagMark tag={row.entry.tag} />
        <IconButton
          icon="more-horizontal"
          size={24}
          className="live-card-more"
          label={`Actions for ${row.title}`}
          {...triggerProps("menu", menuOpen)}
          onClick={(event) => onMenu(event.currentTarget)}
        />
      </div>
    </li>
  );
}

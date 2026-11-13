import type { OverviewTile as TileFacts } from "@localdot/protocol";
import { type ComponentType, type KeyboardEvent, memo, useCallback, useId } from "react";
import { type ConversationRow, STATUS_LABEL, whenLabel } from "../agent/conversation-list.ts";
import { markdownToPlain } from "../agent/markdown.ts";
import { count } from "../copy/format.ts";
import { t, tr } from "../i18n/index.ts";
import { ConversationAvatar } from "../shell/ConversationAvatar.tsx";
import { conversationLabel } from "../shell/SessionRail.tsx";
import { Button } from "../ui/Button.tsx";
import { markOf, TagMark } from "../ui/ConversationTag.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Progress } from "../ui/Progress.tsx";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import type { OverviewDensity, PictureWidth } from "./overview-model.ts";

// The dot over each tile's picture, as large as the tile allows.
const DOT_SIZE: Record<OverviewDensity, number> = { s: 28, m: 36, l: 44 };

const WORD: Partial<Record<ConversationRow["status"], string>> = { waiting: tr("Waiting") };

const NEEDS_WORD = {
  approval: tr("Approve"),
  question: tr("Answer"),
  takeover: tr("Take over"),
  connection: tr("Allow"),
  fix: tr("Fix"),
} as const;

const STATUS_LINE: Partial<Record<ConversationRow["status"], string>> = {
  "needs-you": tr("Waiting for your answer"),
  waiting: tr("Waits for its turn on the computer"),
  idle: tr("Ready for your next message"),
  paused: tr("Paused until you resume it"),
};

// What a tile says under its name: what dot needs, what it is doing, or how it ended.
export function tileLine(row: ConversationRow, facts: TileFacts | undefined): string | undefined {
  if (row.status === "needs-you") {
    const text = facts?.needs?.text && markdownToPlain(facts.needs.text).trim();
    return text || STATUS_LINE["needs-you"];
  }
  if (row.activity) return row.activity;
  const line = STATUS_LINE[row.status];
  if (line) return line;
  return row.entry.line?.trim() || undefined;
}

// How far it has got: through its plan, else in steps.
export function tileProgress(
  row: ConversationRow,
  facts: TileFacts | undefined,
): { text: string; done?: number; total?: number } | undefined {
  const plan = facts?.plan;
  if (plan) {
    const through = t`${plan.done} of ${plan.total}`;
    return { text: plan.current ? `${through} · ${plan.current}` : through, ...plan };
  }
  const steps = facts?.steps ?? 0;
  if (!steps) return undefined;
  return { text: row.active ? t`Step ${steps}` : count(steps, "step", "steps") };
}

export interface TilePictureProps {
  sessionId: string;
  frameId: string | undefined;
  width: PictureWidth;
  // In view on a page someone is looking at: only then is anything loaded.
  active: boolean;
}

export interface OverviewTileProps {
  row: ConversationRow;
  facts: TileFacts | undefined;
  density: OverviewDensity;
  now: Date;
  Picture: ComponentType<TilePictureProps>;
  pictureWidth: PictureWidth;
  inView: boolean;
  tabStop: boolean;
  // Why it can't be opened now.
  blocked?: string | undefined;
  register(id: string, element: HTMLButtonElement | null): void;
  onOpen(row: ConversationRow): void;
  onKeyDown(row: ConversationRow, event: KeyboardEvent<HTMLButtonElement>): void;
  // The pointer rests on it or focus is on it: it is the tile in hand.
  onHand(id: string, inHand: boolean): void;
}

// One conversation in the overview: its latest screen with its dot over the corner, its name, its
// status and progress, and what it needs from the user. Pressing it anywhere opens the conversation.
export const OverviewTile = memo(function OverviewTile({
  row,
  facts,
  density,
  now,
  Picture,
  pictureWidth,
  inView,
  tabStop,
  blocked,
  register,
  onOpen,
  onKeyDown,
  onHand,
}: OverviewTileProps) {
  const lineId = useId();
  const progressId = useId();
  const id = row.entry.sessionId;
  const ref = useCallback(
    (element: HTMLButtonElement | null) => register(id, element),
    [id, register],
  );
  const line = tileLine(row, facts);
  const progress = tileProgress(row, facts);
  const screen = facts?.screen;
  const onScreen = !!row.entry.live?.onScreen;
  const needs = row.status === "needs-you" ? facts?.needs : undefined;
  const small = density === "s";
  const described = [line && lineId, progress && progressId].filter(Boolean).join(" ");
  return (
    <li
      className="overview-cell"
      data-flip={id}
      data-status={row.status}
      data-ended={row.active ? undefined : ""}
    >
      <Button
        ref={ref}
        variant="quiet"
        className="overview-tile"
        tabIndex={tabStop ? 0 : -1}
        aria-label={conversationLabel(row, now)}
        aria-describedby={described || undefined}
        disabledReason={blocked}
        data-on-screen={onScreen || undefined}
        onClick={() => onOpen(row)}
        onKeyDown={(event) => onKeyDown(row, event)}
        onPointerEnter={(event) => event.pointerType === "mouse" && onHand(id, true)}
        onPointerLeave={(event) => event.pointerType === "mouse" && onHand(id, false)}
        onFocus={() => onHand(id, true)}
        onBlur={() => onHand(id, false)}
      >
        <span className="overview-picture" data-empty={facts?.frame ? undefined : ""}>
          <Picture sessionId={id} frameId={facts?.frame} width={pictureWidth} active={inView} />
          <span className="overview-picture-empty" aria-hidden="true">
            <Icon name="monitor" size={small ? 16 : 20} />
          </span>
          {(onScreen || (screen && !small)) && (
            <span className="overview-chips" aria-hidden="true">
              {onScreen && (
                <span className="overview-chip" data-kind="on-screen">
                  <span className="overview-lamp" />
                  {!small && t`On screen`}
                </span>
              )}
              {screen && !small && (
                <span className="overview-chip">
                  <Icon name={screen === "browser" ? "globe" : "monitor"} size={12} />
                  {screen === "browser" ? t`Browser` : t`Desktop`}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="overview-head">
          <TagMark tag={markOf(row.entry)} />
          <span className="overview-dot">
            <ConversationAvatar row={row} size={DOT_SIZE[density]} badged={false} tagged={false} />
          </span>
          <span className="overview-name">
            <span className="overview-title">{row.title}</span>
            <span className="overview-status">
              <SessionGlyph status={row.status} size={12} />
              <span className="overview-word">{WORD[row.status] ?? STATUS_LABEL[row.status]}</span>
              <span className="overview-when num">{whenLabel(row.since, now)}</span>
            </span>
          </span>
        </span>
        {small ? (
          <>
            {line && <VisuallyHidden id={lineId}>{line}</VisuallyHidden>}
            {progress && <VisuallyHidden id={progressId}>{progress.text}</VisuallyHidden>}
          </>
        ) : (
          (progress || line) && (
            <span className="overview-body">
              {progress && (
                <span id={progressId} className="overview-progress">
                  <span className="overview-progress-text num">{progress.text}</span>
                  {progress.total !== undefined && (
                    <Progress
                      label={t`Plan`}
                      value={progress.done ?? 0}
                      max={progress.total}
                      className="overview-progress-bar"
                    />
                  )}
                </span>
              )}
              {line && (
                <span id={lineId} className="overview-line" data-needs={needs ? "" : undefined}>
                  {needs && <span className="overview-needs-word">{NEEDS_WORD[needs.reason]}</span>}
                  {line}
                </span>
              )}
            </span>
          )
        )}
      </Button>
    </li>
  );
});

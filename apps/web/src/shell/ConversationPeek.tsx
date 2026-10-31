import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { type ConversationRow, STATUS_LABEL, whenLabel } from "../agent/conversation-list.ts";
import { TAG_NAMES, TagMark } from "../ui/ConversationTag.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LayerPortal } from "../ui/LayerStack.tsx";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { tokenMs } from "../ui/motion.ts";
import { SessionGlyph } from "../ui/SessionGlyph.tsx";
import "../ui/conversation-switcher.css";

// About as tall as a conversation's menu on a touch screen, kept free under the card.
const MENU_ROOM = 312;
const GAP = 12;
const MARGIN = 16;

export interface Peek {
  row: ConversationRow;
  // The row or card it grows out of, and shrinks back into.
  from: HTMLElement;
}

export interface ConversationPeekProps {
  peek: Peek | null;
  now: Date;
  // The card, for the conversation's menu to hang from.
  cardRef: RefObject<HTMLDivElement | null>;
  // The card has its place, so the menu can open under it.
  onPlaced(): void;
}

const startedAt = (value: string) =>
  new Date(value).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

// A held conversation magnified: its row or card grows in place into a card that says all of it,
// its whole name, what dot is doing, what was first asked and when, while the list behind dims, and
// the menu opens under it, as iOS's preview does. Letting go of the menu shrinks it back into its row.
// The card is for the eye; the row's own name and the menu carry everything to assistive technology.
export function ConversationPeek({ peek, now, cardRef, onPlaced }: ConversationPeekProps) {
  const [shown, setShown] = useState<Peek | null>(peek);
  const [leaving, setLeaving] = useState(false);
  if (peek && peek !== shown) {
    setShown(peek);
    setLeaving(false);
  } else if (!peek && shown && !leaving) setLeaving(true);
  const motion = useRef<Animation | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const placed = useRef(onPlaced);
  placed.current = onPlaced;

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!shown || !card) return;
    const animates = typeof card.animate === "function";
    const was = motion.current;
    if (leaving) {
      const done = () => setShown(null);
      if (!animates) {
        done();
        return;
      }
      if (was && was.playState === "running") {
        was.onfinish = done;
        was.reverse();
        return;
      }
      const style = getComputedStyle(card);
      const back =
        shown.from.isConnected && !matches(REDUCED_MOTION) ? grownFrom(card, shown.from) : null;
      const exit = card.animate(back ? [{}, back] : [{}, { opacity: 0 }], {
        duration: tokenMs(style, "--dur-exit", 180),
        easing: style.getPropertyValue("--ease-exit").trim() || "ease-in",
        fill: "forwards",
      });
      exit.onfinish = done;
      motion.current = exit;
      return;
    }
    // Held again while the last one was still going back: this one starts afresh.
    if (was) {
      was.onfinish = null;
      was.cancel();
      motion.current = null;
    }
    const height = card.offsetHeight;
    const source = shown.from.getBoundingClientRect();
    const top = Math.max(
      MARGIN * 3,
      Math.min(source.top, window.innerHeight - height - GAP - MENU_ROOM - MARGIN),
    );
    card.style.top = `${top}px`;
    card.dataset.placed = "";
    if (animates) {
      const style = getComputedStyle(card);
      const still = matches(REDUCED_MOTION);
      motion.current = card.animate(
        still ? [{ opacity: 0 }, { opacity: 1 }] : [grownFrom(card, shown.from), {}],
        {
          duration: tokenMs(style, still ? "--dur-fade" : "--dur-default", still ? 150 : 470),
          easing: style.getPropertyValue("--ease-spring").trim() || "ease-out",
        },
      );
    }
    placed.current();
  }, [shown, leaving, cardRef]);

  if (!shown) return null;
  const { row } = shown;
  const said = row.entry.said?.trim();
  const tasks = row.entry.sessions.length;
  return (
    <LayerPortal kind="popover" closing={leaving} rootRef={layer}>
      <div className="peek-scrim" aria-hidden="true" />
      <div
        ref={cardRef}
        className="peek-card"
        data-status={row.status}
        data-leaving={leaving || undefined}
        aria-hidden="true"
      >
        <TagMark tag={row.entry.tag} />
        <div className="peek-state">
          <SessionGlyph status={row.status} />
          <span className="peek-word">{STATUS_LABEL[row.status]}</span>
          <span className="num">· {whenLabel(row.since, now)}</span>
          {row.entry.live?.onScreen && (
            <span className="peek-screen">
              <Icon name="monitor" size={12} />
              On screen
            </span>
          )}
        </div>
        <div className="peek-title">{row.title}</div>
        {row.activity && <div className="peek-activity">{row.activity}</div>}
        {said && said !== row.title && <div className="peek-said">“{said}”</div>}
        <div className="peek-facts num">
          {[
            tasks === 1 ? "1 task" : `${tasks} tasks`,
            `Started ${startedAt(row.entry.startedAt)}`,
            row.entry.tag && `${TAG_NAMES[row.entry.tag]} tag`,
            row.entry.pinned && "Pinned",
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
    </LayerPortal>
  );
}

// The card laid over `from`: moved and scaled onto it, and cut to its height, so growing out of it
// reads as the row itself opening up.
function grownFrom(card: HTMLElement, from: HTMLElement): Keyframe {
  const box = card.getBoundingClientRect();
  const source = from.getBoundingClientRect();
  const scale = source.width / (box.width || 1);
  const cut = Math.max(0, box.height - source.height / (scale || 1));
  // Its corners as round as the row's once scaled down onto it.
  const corner =
    (Number.parseFloat(getComputedStyle(from).borderTopLeftRadius) || 0) / (scale || 1);
  return {
    transform: `translate(${source.left - box.left}px, ${source.top - box.top}px) scale(${scale})`,
    clipPath: `inset(0 0 ${cut}px 0 round ${corner}px)`,
    opacity: 0.4,
  };
}

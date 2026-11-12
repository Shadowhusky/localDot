import { type RefObject, useRef } from "react";
import { type ConversationRow, STATUS_LABEL, whenLabel } from "../agent/conversation-list.ts";
import { t } from "../i18n/index.ts";
import { TAG_NAMES, TagMark } from "../ui/ConversationTag.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LayerPortal } from "../ui/LayerStack.tsx";
import { ConversationAvatar } from "./ConversationAvatar.tsx";
import { copyInto, mix, ramp, sizeOf, useLift } from "./phone-lift.ts";
import { clamp, lerp } from "./phone-spring.ts";
import "../ui/conversation-switcher.css";

// About as tall as a conversation's menu on a touch screen, kept free under the card.
const MENU_ROOM = 356;
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
  // Where the card rests, for the conversation's menu to hang from.
  cardRef: RefObject<HTMLDivElement | null>;
  // The card has its place, so the menu can open under it.
  onPlaced(): void;
}

const startedAt = (value: string) =>
  new Date(value).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

const radiusOf = (element: Element) =>
  Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;

// A held conversation magnified: its row or card grows in place into a card that says all of it,
// its whole name, what dot is doing, what was first asked and when, while the list behind dims, and
// the menu opens under it, as iOS's preview does. Letting go of the menu shrinks it back: the copy of
// the row comes back through the card as it goes, and lands on the row's own pixels.
// The card is for the eye; the row's own name and the menu carry everything to assistive technology.
export function ConversationPeek({ peek, now, cardRef, onPlaced }: ConversationPeekProps) {
  const backLayer = useRef<HTMLDivElement>(null);
  const flight = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const placed = useRef(onPlaced);
  placed.current = onPlaced;

  const { shown, leaving } = useLift(peek, flight, ({ from }) => {
    const details = card.current;
    const anchor = cardRef.current;
    const back = plate.current;
    const row = copy.current;
    if (!details || !anchor || !back || !row) return null;
    const height = details.offsetHeight;
    const source = from.getBoundingClientRect();
    const top = Math.max(
      MARGIN * 3,
      Math.min(source.top, window.innerHeight - height - GAP - MENU_ROOM - MARGIN),
    );
    details.style.top = `${top}px`;
    const place = { x: details.offsetLeft, y: top, w: details.offsetWidth, h: height };
    Object.assign(anchor.style, {
      top: `${top}px`,
      left: `${place.x}px`,
      width: `${place.w}px`,
      height: `${height}px`,
    });
    const fromRadius = radiusOf(from);
    const toRadius = radiusOf(back);
    copyInto(row, from);
    const width = sizeOf(from).w || 1;
    placed.current();
    return {
      place,
      dim: scrim.current,
      refresh: () => copyInto(row, from),
      draw: (t, at) => {
        const box = mix(at, place, t);
        const scale = box.w / place.w;
        const radius = lerp(fromRadius, toRadius, clamp(t));
        back.style.transform = `translate3d(${box.x}px,${box.y}px,0)`;
        back.style.width = `${box.w}px`;
        back.style.height = `${box.h}px`;
        back.style.borderRadius = `${radius}px`;
        back.style.opacity = String(ramp(t, 0, 0.3));
        details.style.transform = `translate3d(${box.x - place.x}px,${box.y - place.y}px,0) scale(${scale})`;
        details.style.clipPath = `inset(0 0 ${Math.max(0, place.h - box.h / scale)}px 0 round ${radius / scale}px)`;
        details.style.opacity = String(ramp(t, 0.3, 0.8));
        row.style.transform = `translate3d(${box.x}px,${box.y}px,0) scale(${box.w / width})`;
        row.style.opacity = String(1 - ramp(t, 0.15, 0.55));
      },
    };
  });

  if (!shown) return null;
  const { row } = shown;
  const said = row.entry.said?.trim();
  const tasks = row.entry.sessions.length;
  return (
    <>
      <LayerPortal kind="popover" closing={leaving} rootRef={backLayer}>
        <div ref={scrim} className="peek-scrim" aria-hidden="true" />
        <div ref={cardRef} className="peek-anchor" aria-hidden="true" />
      </LayerPortal>
      <LayerPortal kind="popover" closing={leaving} rootRef={flight} className="lift-layer">
        <div ref={plate} className="peek-plate" aria-hidden="true" />
        <div ref={card} className="peek-card" data-status={row.status} aria-hidden="true">
          <TagMark tag={row.entry.tag} />
          <div className="peek-state">
            <ConversationAvatar row={row} size={28} tagged={false} />
            <span className="peek-word">{STATUS_LABEL[row.status]}</span>
            <span className="num">· {whenLabel(row.since, now)}</span>
            {row.entry.live?.onScreen && (
              <span className="peek-screen">
                <Icon name="monitor" size={12} />
                {t`On screen`}
              </span>
            )}
          </div>
          <div className="peek-title">{row.title}</div>
          {row.activity && <div className="peek-activity">{row.activity}</div>}
          {said && said !== row.title && <div className="peek-said">“{said}”</div>}
          <div className="peek-facts num">
            {[
              tasks === 1 ? t`1 task` : t`${tasks} tasks`,
              t`Started ${startedAt(row.entry.startedAt)}`,
              row.entry.tag && t`${TAG_NAMES[row.entry.tag]} tag`,
              row.entry.pinned && t`Pinned`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <div ref={copy} className="lift-copy peek-row" aria-hidden="true" inert />
      </LayerPortal>
    </>
  );
}

import { useEffect, useRef } from "react";
import { copyInto, mix, ramp, sizeOf, useLift } from "../shell/phone-lift.ts";
import { clamp } from "../shell/phone-spring.ts";
import type { IconName } from "../ui/icons.ts";
import { LayerPortal } from "../ui/LayerStack.tsx";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu.tsx";

export interface BubbleItem {
  label: string;
  icon: IconName;
  run(): void;
}

export interface HeldBubble {
  // The bubble held, which lifts out of the page.
  from: HTMLElement;
  // Quiet facts above the items: when, on what model, how long and at what cost.
  note?: string;
  items: readonly BubbleItem[];
  // Your own messages lift to their side and their menu opens under that edge.
  mine: boolean;
}

const ITEM_PX = 44;
const NOTE_PX = 40;
const MENU_PAD = 12;
const GAP = 10;
const LIFT = 1.025;
const EDGE = 10;
// How much of a bubble too tall for the screen fades out at the foot of its preview.
const FADE_PX = 40;

// A hold: the bubble lifts out of the page, the page goes behind glass and the menu grows from under
// it. Sliding to an item and letting go chooses it, as iOS does.
export function BubbleMenu({ held, onClose }: { held: HeldBubble | null; onClose(): void }) {
  const backLayer = useRef<HTMLDivElement>(null);
  const flight = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLElement | null>(null);

  const { shown, leaving } = useLift(held, flight, ({ from, items, note }) => {
    const shade = plate.current;
    const card = preview.current;
    const bubble = copy.current;
    if (!shade || !card || !bubble) return null;
    copyInto(bubble, from);
    anchor.current = card;
    const seen = from.getBoundingClientRect();
    const width = sizeOf(from).w || seen.width;
    const menuHeight = items.length * ITEM_PX + (note ? NOTE_PX : 0) + MENU_PAD + GAP * 2;
    const height = window.visualViewport?.height ?? window.innerHeight;
    const room = height - menuHeight - EDGE * 2;
    const clipped = seen.height > room;
    card.toggleAttribute("data-clip", clipped);
    const rest = Math.min(seen.height, room);
    const top = Math.max(EDGE, Math.min(seen.top, height - menuHeight - rest));
    const radius = getComputedStyle(from).borderRadius;
    shade.style.borderRadius = radius;
    card.style.borderRadius = radius;
    card.style.width = `${width}px`;
    shade.style.width = `${width}px`;
    return {
      // Grown a little about its own middle.
      place: {
        x: seen.left + (width * (1 - LIFT)) / 2,
        y: top + (rest * (1 - LIFT)) / 2,
        w: width * LIFT,
        h: rest * LIFT,
      },
      dim: back.current,
      refresh: () => copyInto(bubble, from),
      draw(t, at) {
        const box = mix(at, this.place, t);
        const scale = box.w / width;
        const transform = `translate3d(${box.x}px,${box.y}px,0) scale(${scale})`;
        card.style.transform = transform;
        card.style.height = `${box.h / scale}px`;
        card.style.setProperty("--_fade", `${FADE_PX * clamp(t)}px`);
        shade.style.transform = transform;
        shade.style.height = card.style.height;
        shade.style.opacity = String(ramp(t, 0, 0.4));
      },
    };
  });

  // Sliding on from the hold: the item under the finger lights, and letting go there chooses it.
  useEffect(() => {
    if (!held) return;
    let moved = false;
    const itemAt = (event: PointerEvent) =>
      document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[role="menuitem"]') ?? null;
    const light = (item: HTMLElement | null) => {
      for (const other of document.querySelectorAll("[data-hot]"))
        if (other !== item) other.removeAttribute("data-hot");
      item?.setAttribute("data-hot", "");
    };
    const move = (event: PointerEvent) => {
      moved = true;
      light(itemAt(event));
    };
    const stay = (event: TouchEvent) => event.preventDefault();
    const up = (event: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.removeEventListener("touchmove", stay);
      if (!moved) return;
      const item = itemAt(event);
      light(null);
      const chosen = item && held.items.find((each) => each.label === item.dataset.label);
      if (!chosen) return;
      onClose();
      chosen.run();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.addEventListener("touchmove", stay, { passive: false });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.removeEventListener("touchmove", stay);
    };
  }, [held, onClose]);

  if (!shown) return null;
  return (
    <>
      <LayerPortal kind="popover" closing={leaving} rootRef={backLayer}>
        <div ref={back} className="bubble-hold-back" aria-hidden="true" />
      </LayerPortal>
      <LayerPortal kind="popover" closing={leaving} rootRef={flight} className="lift-layer">
        <div ref={plate} className="bubble-hold-plate" aria-hidden="true" />
        <div ref={preview} className="lift-copy bubble-hold-preview" aria-hidden="true" inert>
          <div ref={copy} className="bubble-hold-copy" />
        </div>
      </LayerPortal>
      <Menu
        open={!!held}
        onClose={onClose}
        anchor={anchor}
        side="bottom"
        align={shown.mine ? "end" : "start"}
        label="Message actions"
      >
        {shown.note && (
          <>
            <p className="bubble-hold-note num">{shown.note}</p>
            <MenuSeparator />
          </>
        )}
        {shown.items.map((item) => (
          <MenuItem key={item.label} icon={item.icon} onSelect={item.run}>
            {item.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

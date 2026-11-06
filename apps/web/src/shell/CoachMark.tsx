import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import "../ui/phone-layout.css";

const SHOWN_MS = 6500;
// A press that dismissed it must not be the press that showed it.
const ARMED_MS = 300;
const LEAVING_MS = 190;
const MARGIN = 8;
const GAP = 4;

// A tip with an arrow at what it is about, gone after a while or at the next press.
export function CoachMark({
  anchor,
  title,
  children,
  onDone,
}: {
  anchor: RefObject<HTMLElement | null>;
  title: string;
  children: string;
  onDone(): void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  useLayoutEffect(() => {
    const element = card.current;
    const at = anchor.current;
    const parent = element?.offsetParent;
    if (!element || !at || !parent) return;
    const box = parent.getBoundingClientRect();
    const target = at.getBoundingClientRect();
    const centre = target.left + target.width / 2 - box.left;
    const width = element.offsetWidth;
    const left = Math.max(MARGIN, Math.min(centre - width + 22, box.width - width - MARGIN));
    element.style.left = `${left}px`;
    element.style.top = `${target.bottom - box.top + GAP}px`;
    element.style.setProperty("--_arrow", `${centre - left}px`);
  }, [anchor]);
  useEffect(() => {
    const leave = () => setLeaving(true);
    const timer = setTimeout(leave, SHOWN_MS);
    const armed = setTimeout(
      () => window.addEventListener("pointerdown", leave, { capture: true, once: true }),
      ARMED_MS,
    );
    return () => {
      clearTimeout(timer);
      clearTimeout(armed);
      window.removeEventListener("pointerdown", leave, { capture: true });
    };
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => done.current(), LEAVING_MS);
    return () => clearTimeout(timer);
  }, [leaving]);
  return (
    <div ref={card} className="phone-coach" role="status" data-leaving={leaving || undefined}>
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  );
}

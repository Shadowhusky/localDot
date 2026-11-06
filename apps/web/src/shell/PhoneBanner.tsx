import { type AttentionItem, NOTIFY_COPY, notifyRouteOf, type Wearable } from "@localdot/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DotAvatar } from "../dot/DotAvatar.tsx";
import { Button } from "../ui/Button.tsx";
import { project, rubberband } from "../ui/sheet-drag.ts";
import { onSpringFrame, Spring, Velocity } from "./phone-spring.ts";
import "../ui/phone-layout.css";

const SHOWN_MS = 5000;
const AGAIN_MS = 4000;
const AWAY_PX = 30;
const MOVED_PX = 8;

interface Shown {
  sessionId: string;
  title: string;
  text: string;
  look?: readonly Wearable[];
  attention: boolean;
}

export interface PhoneBannerProps {
  latest: AttentionItem | null;
  // The task on screen says for itself; a hidden tab leaves it to notifications.
  viewing: string | null;
  // The list on show says it in its rows.
  quiet: boolean;
  nameOf(sessionId: string): { title?: string; look?: readonly Wearable[] } | undefined;
  onOpen(sessionId: string): void;
}

// Another task that needs the user, finishes or fails says so at the top of the conversation. A tap
// opens it, a flick up sends it away, and it goes by itself; a task that moves on takes it back.
export function PhoneBanner({ latest, viewing, quiet, nameOf, onOpen }: PhoneBannerProps) {
  const [shown, setShown] = useState<Shown | null>(null);
  const place = useRef({ viewing, quiet, nameOf });
  place.current = { viewing, quiet, nameOf };
  useEffect(() => {
    const sessionId = latest?.sessionId;
    if (!latest || !sessionId) return;
    const route = notifyRouteOf(latest.reason);
    if (!route) {
      setShown((was) => (was?.sessionId === sessionId ? null : was));
      return;
    }
    const now = place.current;
    if (sessionId === now.viewing || now.quiet || document.hidden) return;
    const named = now.nameOf(sessionId);
    const copy = NOTIFY_COPY[route.kind];
    setShown({
      sessionId,
      title: named?.title ?? latest.task ?? copy.title,
      text: named?.title || latest.task ? copy.title : copy.body,
      ...(named?.look ? { look: named.look } : {}),
      attention: latest.level === "needs_you",
    });
  }, [latest]);
  return shown ? (
    <Banner
      key={shown.sessionId}
      shown={shown}
      onGone={() => setShown(null)}
      onOpen={() => onOpen(shown.sessionId)}
    />
  ) : null;
}

function Banner({ shown, onGone, onOpen }: { shown: Shown; onGone(): void; onOpen(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const y = useRef(new Spring(-200));
  const away = useRef(-200);
  const gone = useRef(onGone);
  gone.current = onGone;
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const parent = element.offsetParent;
    const height = element.offsetHeight + (parent ? element.offsetTop : 0) + 16;
    away.current = -height;
    const spring = y.current;
    spring.set(-height);
    const draw = () => {
      element.style.transform = `translate3d(0,${spring.x}px,0)`;
    };
    draw();
    spring.to(0, { response: 0.42, damping: 0.86 });
    return onSpringFrame(draw);
  }, []);
  const leave = (velocity?: number) =>
    y.current.to(away.current, {
      response: 0.36,
      damping: 1,
      velocity,
      done: () => gone.current(),
    });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one timer for the banner's life.
  useEffect(() => {
    timer.current = setTimeout(() => leave(), SHOWN_MS);
    return () => clearTimeout(timer.current);
  }, []);
  const finger = useRef<{ y: number; moved: boolean; v: Velocity } | null>(null);
  const element = host;
  return (
    <div
      ref={host}
      className="phone-banner"
      role="status"
      onPointerDown={(event) => {
        finger.current = { y: event.clientY, moved: false, v: new Velocity() };
        clearTimeout(timer.current);
        element.current?.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const held = finger.current;
        if (!held) return;
        const moved = event.clientY - held.y;
        if (Math.abs(moved) > MOVED_PX) held.moved = true;
        y.current.set(moved > 0 ? rubberband(moved, window.innerHeight) : moved);
        held.v.add(y.current.x);
        if (element.current) element.current.style.transform = `translate3d(0,${y.current.x}px,0)`;
      }}
      onPointerUp={() => {
        const held = finger.current;
        finger.current = null;
        if (!held) return;
        const v = held.v.get();
        if (!held.moved) {
          leave();
          onOpen();
          return;
        }
        if (y.current.x + project(v) < -AWAY_PX) leave(v);
        else {
          y.current.to(0, { response: 0.4, damping: 1, velocity: v });
          timer.current = setTimeout(() => leave(), AGAIN_MS);
        }
      }}
      onPointerCancel={() => {
        finger.current = null;
        y.current.to(0, { response: 0.4, damping: 1 });
      }}
    >
      <span className="phone-banner-avatar" data-attention={shown.attention || undefined}>
        <DotAvatar size={52} wearables={shown.look ?? []} seed={shown.sessionId} />
      </span>
      <span className="phone-banner-words">
        <strong>{shown.title}</strong>
        <span>{shown.text}</span>
      </span>
      <small>Now</small>
      <Button
        variant="quiet"
        className="phone-banner-open"
        aria-label={`Open ${shown.title}`}
        onClick={onOpen}
      />
    </div>
  );
}

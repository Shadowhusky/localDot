import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ApiClient } from "../lib/api.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { tokenMs } from "../ui/motion.ts";
import { moveQueuedMessage } from "./control-api.ts";

export interface QueueMoves {
  // The waiting messages, in the order dot will receive them.
  readonly order: readonly string[];
  move(id: string, to: number): void;
  // Moved by the keys, this message's handle keeps focus as its row changes place.
  readonly refocus: { current: string | null };
  readonly problem: string | null;
}

// How long a moved order is held once the task has taken it, for the event that says so.
const SETTLE_MS = 2000;

function inOrder(ids: readonly string[], order: readonly string[] | undefined) {
  if (!order) return ids;
  const place = new Map(order.map((id, index) => [id, index]));
  return [...ids].sort((a, b) => (place.get(a) ?? order.length) - (place.get(b) ?? order.length));
}

// The queue lives in the task, which delivers it in the order it holds and tells every viewer. A
// move shows at once and is sent in turn; a move the task turns down, because the message has
// started or left, shows the task's own order again.
export function useQueueMoves(
  api: ApiClient | null,
  sessionId: string | null,
  told: readonly string[] | undefined,
  waiting: readonly string[],
): QueueMoves {
  const [mine, setMine] = useState<readonly string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const key = waiting.join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined ids are the list's identity.
  const order = useMemo(() => inOrder(waiting, mine ?? told), [key, mine, told]);
  const latest = useRef(order);
  latest.current = order;
  const refocus = useRef<string | null>(null);
  const sending = useRef(Promise.resolve());
  const inFlight = useRef(0);
  const settle = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!mine || !told) return;
    if (mine.length === told.length && mine.every((id, index) => id === told[index])) setMine(null);
  }, [mine, told]);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    return () => {
      abort.abort();
      window.clearTimeout(settle.current);
    };
  }, []);
  const move = useCallback(
    (id: string, to: number) => {
      const signal = lifetime.current?.signal;
      const from = latest.current.indexOf(id);
      if (!api || !sessionId || !signal || from < 0) return;
      if (to === from || to < 0 || to >= latest.current.length) return;
      const next = [...latest.current];
      next.splice(from, 1);
      next.splice(to, 0, id);
      window.clearTimeout(settle.current);
      inFlight.current += 1;
      flushSync(() => {
        setMine(next);
        setProblem(null);
      });
      const before = next[to + 1] ?? null;
      sending.current = sending.current
        .then(() => moveQueuedMessage(api, sessionId, id, before, signal))
        .catch(() => {
          if (signal.aborted) return;
          setMine(null);
          setProblem("Couldn't move that message. It may have started already.");
        })
        .finally(() => {
          inFlight.current -= 1;
          if (!inFlight.current) settle.current = window.setTimeout(() => setMine(null), SETTLE_MS);
        });
    },
    [api, sessionId],
  );
  return useMemo(() => ({ order, move, refocus, problem }), [order, move, problem]);
}

interface Drag {
  readonly pointer: number;
  readonly y: number;
  readonly from: number;
  readonly rows: readonly HTMLElement[];
  readonly tops: readonly number[];
  readonly heights: readonly number[];
  to: number;
}

// The handle a waiting message moves by: drag it by mouse or touch, or use the arrow keys.
export function QueueHandle({
  id,
  moves,
  announce,
}: {
  id: string;
  moves: QueueMoves;
  announce(text: string): void;
}) {
  const handle = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const { order } = moves;
  const place = order.indexOf(id);
  useLayoutEffect(() => {
    if (moves.refocus.current !== id) return;
    moves.refocus.current = null;
    handle.current?.focus({ preventScroll: true });
  });
  const moved = (to: number) => announce(`Moved to place ${to + 1} of ${order.length}.`);
  const end = (commit: boolean) => {
    const now = drag.current;
    if (!now) return;
    drag.current = null;
    const row = now.rows[now.from];
    const held = row?.getBoundingClientRect().top ?? 0;
    for (const each of now.rows) {
      each.style.removeProperty("translate");
      each.removeAttribute("data-queue-moving");
      each.removeAttribute("data-queue-dragged");
    }
    if (commit && now.to !== now.from) {
      moves.move(id, now.to);
      moved(now.to);
    }
    if (!row || matches(REDUCED_MOTION) || typeof row.animate !== "function") return;
    const style = getComputedStyle(row);
    row.animate(
      [{ translate: `0 ${held - row.getBoundingClientRect().top}px` }, { translate: "0 0" }],
      {
        duration: tokenMs(style, "--dur-hover", 120),
        easing: style.getPropertyValue("--ease-standard").trim() || "ease-out",
      },
    );
  };
  return (
    <IconButton
      ref={handle}
      className="thread-queue-handle"
      icon="grip-vertical"
      size={24}
      label={`Move this message, place ${place + 1} of ${order.length}`}
      aria-keyshortcuts="ArrowUp ArrowDown"
      data-queue-handle=""
      // A drag selects no text and leaves focus where the user was typing.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const rows = [
          ...(handle.current
            ?.closest(".thread")
            ?.querySelectorAll<HTMLElement>("[data-queue-handle]") ?? []),
        ].flatMap((each) => each.closest<HTMLElement>(".thread-row") ?? []);
        const row = rows[place];
        if (!row || rows.length !== order.length) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const boxes = rows.map((each) => each.getBoundingClientRect());
        drag.current = {
          pointer: event.pointerId,
          y: event.clientY,
          from: place,
          to: place,
          rows,
          tops: boxes.map((box) => box.top),
          heights: boxes.map((box) => box.height),
        };
        for (const each of rows) each.toggleAttribute("data-queue-moving", true);
        row.toggleAttribute("data-queue-dragged", true);
      }}
      onPointerMove={(event) => {
        const now = drag.current;
        if (!now || event.pointerId !== now.pointer) return;
        const by = event.clientY - now.y;
        const top = (index: number) => now.tops[index] ?? 0;
        const height = (index: number) => now.heights[index] ?? 0;
        const middle = top(now.from) + height(now.from) / 2 + by;
        let to = now.from;
        now.rows.forEach((_, index) => {
          const passed = top(index) + height(index) / 2;
          if (index < now.from && middle < passed) to = Math.min(to, index);
          if (index > now.from && middle > passed) to = Math.max(to, index);
        });
        now.to = to;
        const next = now.from + 1 < now.rows.length ? now.from + 1 : now.from - 1;
        const gap = Math.abs(top(next) - top(now.from)) - height(Math.min(next, now.from));
        const span = height(now.from) + gap;
        now.rows.forEach((row, index) => {
          const shift =
            index === now.from
              ? by
              : index > now.from && index <= to
                ? -span
                : index < now.from && index >= to
                  ? span
                  : 0;
          row.style.setProperty("translate", `0 ${shift}px`);
        });
      }}
      onPointerUp={(event) => {
        if (event.pointerId === drag.current?.pointer) end(true);
      }}
      onPointerCancel={(event) => {
        if (event.pointerId === drag.current?.pointer) end(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && drag.current) {
          event.stopPropagation();
          end(false);
          return;
        }
        const to =
          event.key === "ArrowUp"
            ? place - 1
            : event.key === "ArrowDown"
              ? place + 1
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? order.length - 1
                  : -1;
        if (to < 0 || to >= order.length) return;
        event.preventDefault();
        if (to === place) return;
        moves.refocus.current = id;
        moves.move(id, to);
        moved(to);
      }}
    />
  );
}

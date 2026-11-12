import type { OverviewTile as TileFacts } from "@localdot/protocol";
import {
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConversationRow } from "../agent/conversation-list.ts";
import { t, tr } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { useFlip } from "../ui/flip.ts";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { useHandler } from "../ui/useHandler.ts";
import { OverviewTile, type TilePictureProps } from "./OverviewTile.tsx";
import {
  columnsFor,
  filterCounts,
  filterRows,
  heldOrder,
  moveFocus,
  type OverviewDensity,
  type OverviewFilter,
  overviewRows,
  pictureWidth,
  TILE_GAP,
} from "./overview-model.ts";
import "../ui/overview.css";

// A pointer that rests this long on a tile takes it in hand: its picture sharpens and is read more
// often. Passing over tiles on the way to another loads nothing extra.
export const HAND_DWELL_MS = 300;
// The order holds while the pointer moves over the tiles, and this long after it stops.
export const HOLD_MS = 3_000;
// Tiles this far outside the view are read ahead, so a scroll finds them drawn.
const AHEAD_PX = 240;
const AHEAD = `${AHEAD_PX}px 0px`;
const SETTLE_MS = 150;

const FILTER_ITEMS = (counts: Record<OverviewFilter, number>) => [
  { value: "all", label: t`All`, count: counts.all },
  { value: "working", label: t`Working`, count: counts.working },
  {
    value: "needs-you",
    label: t`Needs you`,
    count: counts["needs-you"],
    attention: counts["needs-you"] > 0,
  },
];

const DENSITY_ITEMS = [
  { value: "s", label: tr("S"), hint: tr("Small tiles") },
  { value: "m", label: tr("M"), hint: tr("Medium tiles") },
  { value: "l", label: tr("L"), hint: tr("Large tiles") },
];

const EMPTY_FILTER: Record<Exclude<OverviewFilter, "all">, string> = {
  working: tr("No dot is working right now"),
  "needs-you": tr("No dot needs you right now"),
};

export interface OverviewGridProps {
  rows: readonly ConversationRow[];
  tiles: ReadonlyMap<string, TileFacts>;
  now: Date;
  density: OverviewDensity;
  filter: OverviewFilter;
  onDensity(density: OverviewDensity): void;
  onFilter(filter: OverviewFilter): void;
  Picture: ComponentType<TilePictureProps>;
  // On screen: while off, no tile loads anything.
  shown: boolean;
  // Why another conversation can't be taken up now, and the one that can.
  reason?: string | undefined;
  current: string | null;
  // What stands above the controls: a page's title and Back, where the top bar doesn't name it.
  heading?: ReactNode;
  onOpen(row: ConversationRow): void;
  // The tiles in view, in order, and the one in hand.
  onInView(ids: readonly string[]): void;
  onHand(id: string | null): void;
}

// Every conversation under way and those from today, one tile each, most urgent first, in as many
// columns as the room and the chosen size allow. Arrows move between tiles and Return opens one.
export function OverviewGrid({
  rows,
  tiles,
  now,
  density,
  filter,
  onDensity,
  onFilter,
  Picture,
  shown,
  reason,
  current,
  heading,
  onOpen,
  onInView,
  onHand,
}: OverviewGridProps) {
  const ordered = useMemo(() => overviewRows(rows, now.getTime()), [rows, now]);
  const counts = useMemo(() => filterCounts(ordered), [ordered]);
  const listed = useMemo(() => filterRows(ordered, filter), [ordered, filter]);

  // Nothing moves under the user: while they point along the tiles or work in them with the keys,
  // the tiles keep their places, and take their new ones once let go.
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusWithin = useRef(false);
  const shownOrder = useRef<string[]>([]);
  const next = listed.map((row) => row.entry.sessionId);
  const order = holding ? heldOrder(shownOrder.current, next) : next;
  shownOrder.current = order;
  const byId = new Map(listed.map((row) => [row.entry.sessionId, row]));
  const shownRows = order.flatMap((id) => byId.get(id) ?? []);
  const hold = () => {
    clearTimeout(holdTimer.current);
    setHolding(true);
    holdTimer.current = setTimeout(() => {
      if (!focusWithin.current) setHolding(false);
    }, HOLD_MS);
  };
  const letGo = () => {
    clearTimeout(holdTimer.current);
    if (!focusWithin.current) setHolding(false);
  };
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  const scroller = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useFlip(scroller, order.join(" "));

  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    setWidth(element.clientWidth);
    // Read in the next frame: the columns it sets can bring a scrollbar, which changes the width.
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      if (entry) frame = requestAnimationFrame(() => setWidth(entry.contentRect.width));
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  const columns = columnsFor(width, density);
  const gap = TILE_GAP[density];
  const tileWidth = width ? (width - gap * (columns - 1)) / columns : 0;
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  // Which tiles are in view, read by one observer, so those out of it load and ask for nothing.
  const [inView, setInView] = useState<ReadonlySet<string>>(() => new Set());
  const cells = useRef(new Map<Element, string>());
  const observer = useRef<IntersectionObserver | null>(null);
  useLayoutEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const watching = new IntersectionObserver(
      (entries) =>
        setInView((was) => {
          const now = new Set(was);
          for (const entry of entries) {
            const id = cells.current.get(entry.target);
            if (!id) continue;
            if (entry.isIntersecting) now.add(id);
            else now.delete(id);
          }
          return now.size === was.size && [...now].every((id) => was.has(id)) ? was : now;
        }),
      { root: scroller.current, rootMargin: AHEAD },
    );
    observer.current = watching;
    for (const cell of cells.current.keys()) watching.observe(cell);
    return () => {
      watching.disconnect();
      observer.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const present = new Map<Element, string>();
    for (const cell of element.querySelectorAll<HTMLElement>(":scope > [data-flip]"))
      present.set(cell, cell.dataset.flip ?? "");
    for (const cell of cells.current.keys())
      if (!present.has(cell)) observer.current?.unobserve(cell);
    for (const cell of present.keys())
      if (!cells.current.has(cell)) observer.current?.observe(cell);
    cells.current = present;
  });
  const visible = order.filter((id) => inView.has(id));
  const visibleKey = shown ? visible.join(",") : "";
  const reportInView = useHandler(onInView);
  // Reported once the tiles have settled into their places, and checked against where each is
  // then, so the first layout, before the grid knows its width, asks about nothing out of view.
  useEffect(() => {
    const timer = setTimeout(() => {
      const view = scroller.current?.getBoundingClientRect();
      const near = (cell: Element) => {
        const box = cell.getBoundingClientRect();
        if (!view?.height || !box.height) return false;
        return box.bottom > view.top - AHEAD_PX && box.top < view.bottom + AHEAD_PX;
      };
      const ids = new Set(visibleKey ? visibleKey.split(",") : []);
      reportInView(
        [...cells.current].flatMap(([cell, id]) => (ids.has(id) && near(cell) ? [id] : [])),
      );
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [visibleKey, reportInView]);

  // The tile in hand: rested on, or focused, for a moment.
  const [hand, setHand] = useState<string | null>(null);
  const handTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reportHand = useHandler(onHand);
  useEffect(() => reportHand(hand), [hand, reportHand]);
  useEffect(() => () => clearTimeout(handTimer.current), []);
  const takeInHand = useHandler((id: string, inHand: boolean) => {
    clearTimeout(handTimer.current);
    if (inHand) handTimer.current = setTimeout(() => setHand(id), HAND_DWELL_MS);
    else setHand((was) => (was === id ? null : was));
  });

  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const register = useHandler((id: string, element: HTMLButtonElement | null) => {
    if (element) buttons.current.set(id, element);
    else buttons.current.delete(id);
  });
  const [focused, setFocused] = useState<string | null>(null);
  const tabStop = focused && order.includes(focused) ? focused : (order[0] ?? null);
  const keyDown = useHandler((row: ConversationRow, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const at = order.indexOf(row.entry.sessionId);
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const to = moveFocus(at, event.key, columns, order.length, rtl);
    if (to === undefined || to === at) {
      if (to === at) event.preventDefault();
      return;
    }
    event.preventDefault();
    const id = order[to];
    const target = id ? buttons.current.get(id) : undefined;
    if (!id || !target) return;
    setFocused(id);
    target.focus();
    target.scrollIntoView({ block: "nearest" });
  });
  const open = useHandler(onOpen);

  const filters = (
    <SegmentedControl
      aria-label={t`Show`}
      size={28}
      fit
      className="overview-filter"
      items={FILTER_ITEMS(counts)}
      value={filter}
      onValueChange={(value) => onFilter(value as OverviewFilter)}
    />
  );
  const sizes = (
    <SegmentedControl
      aria-label={t`Tile size`}
      size={28}
      className="overview-density"
      items={DENSITY_ITEMS}
      value={density}
      onValueChange={(value) => onDensity(value as OverviewDensity)}
    />
  );

  let body: ReactNode = null;
  if (ordered.length === 0)
    body = (
      <EmptyState icon="layout-dashboard" title={t`Nothing to show yet`}>
        {t`Conversations under way, and those from today, show here with their screens.`}
      </EmptyState>
    );
  else if (filter !== "all" && listed.length === 0)
    body = (
      <EmptyState
        icon="layout-dashboard"
        title={EMPTY_FILTER[filter]}
        actions={
          <Button size="sm" variant="quiet" onClick={() => onFilter("all")}>
            {t`Show all`}
          </Button>
        }
      />
    );

  return (
    <section className="overview" aria-label={t`Overview`} data-density={density}>
      <header className="overview-bar" data-page={heading ? "" : undefined}>
        {heading}
        {filters}
        {sizes}
      </header>
      <ScrollArea ref={scroller} className="overview-scroll" fade="both">
        {body}
        <ul
          ref={list}
          className="overview-grid"
          aria-label={t`Conversations`}
          hidden={!!body}
          style={
            {
              "--_cols": columns,
            } as CSSProperties
          }
          onPointerMove={(event) => event.pointerType === "mouse" && hold()}
          onPointerLeave={letGo}
          onFocus={(event) => {
            focusWithin.current = true;
            setHolding(true);
            const id = event.target.closest<HTMLElement>("[data-flip]")?.dataset.flip;
            if (id) setFocused(id);
          }}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            focusWithin.current = false;
            letGo();
          }}
        >
          {shownRows.map((row) => {
            const id = row.entry.sessionId;
            return (
              <OverviewTile
                key={id}
                row={row}
                facts={tiles.get(id)}
                density={density}
                now={now}
                Picture={Picture}
                pictureWidth={pictureWidth(tileWidth, ratio, hand === id)}
                inView={shown && inView.has(id)}
                tabStop={id === tabStop}
                blocked={reason && id !== current ? reason : undefined}
                register={register}
                onOpen={open}
                onKeyDown={keyDown}
                onHand={takeInHand}
              />
            );
          })}
        </ul>
      </ScrollArea>
    </section>
  );
}

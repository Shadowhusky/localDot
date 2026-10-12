import { type PointerEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentModel } from "../agent/model.ts";
import { Glyph } from "../dot/Glyph.tsx";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import {
  notifyCommandsVisibility,
  onShowCommands,
  readWorkLayout,
  WORK_LAYOUT_KEY,
  type WorkLayout,
  workTranscript,
} from "./work-overlay.ts";

export function WorkOverlay({ model, working }: { model: AgentModel; working: boolean }) {
  const { steps, changes } = model;
  const [layout, setLayout] = useState(readWorkLayout);
  const transcript = useMemo(
    () => (layout.hidden ? { entries: [], background: false } : workTranscript({ steps, changes })),
    [steps, changes, layout.hidden],
  );
  const hasEntries = transcript.entries.length > 0;
  const [bounds, setBounds] = useState({ width: 0, height: 0, panelWidth: 0, panelHeight: 0 });
  const layer = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const output = useRef<HTMLElement>(null);
  const follow = useRef(true);
  const drag = useRef<{ id: number; x: number; y: number; start: WorkLayout } | null>(null);
  const latest = useRef(layout);
  latest.current = layout;
  const availableX = Math.max(0, bounds.width - bounds.panelWidth - 16);
  const availableY = Math.max(0, bounds.height - bounds.panelHeight - 16);
  const save = (value: WorkLayout) => {
    latest.current = value;
    setLayout(value);
    try {
      localStorage.setItem(WORK_LAYOUT_KEY, JSON.stringify(value));
      notifyCommandsVisibility();
    } catch {}
  };
  useLayoutEffect(
    () =>
      onShowCommands((hidden) => {
        const value = { ...latest.current, hidden, minimized: false };
        latest.current = value;
        setLayout(value);
        try {
          localStorage.setItem(WORK_LAYOUT_KEY, JSON.stringify(value));
          notifyCommandsVisibility();
        } catch {}
      }),
    [],
  );
  useLayoutEffect(() => {
    if (layout.hidden || !hasEntries || !layer.current || !panel.current) return;
    const measure = () => {
      const next = {
        width: layer.current?.clientWidth ?? 0,
        height: layer.current?.clientHeight ?? 0,
        panelWidth: panel.current?.offsetWidth ?? 0,
        panelHeight: panel.current?.offsetHeight ?? 0,
      };
      setBounds((old) =>
        old.width === next.width &&
        old.height === next.height &&
        old.panelWidth === next.panelWidth &&
        old.panelHeight === next.panelHeight
          ? old
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer.current);
    observer.observe(panel.current);
    return () => observer.disconnect();
  }, [hasEntries, layout.hidden]);
  useLayoutEffect(() => {
    const node = handle.current;
    if (!node || !hasEntries || layout.hidden) return;
    const preventScroll = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    node.addEventListener("touchmove", preventScroll, { passive: false });
    return () => node.removeEventListener("touchmove", preventScroll);
  }, [hasEntries, layout.hidden]);
  useLayoutEffect(() => {
    if (!layout.hidden && transcript.entries.length && follow.current && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [transcript, layout.hidden]);
  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    save(latest.current);
  };
  if (!transcript.entries.length || layout.hidden) return null;
  return (
    <div className="work-overlay-layer" ref={layer}>
      <section
        className="work-overlay"
        aria-label="Background work"
        ref={panel}
        style={{
          left: `calc(${layout.x * 100}% + ${8 - layout.x * 16}px)`,
          top: `calc(${layout.y * 100}% + ${8 - layout.y * 16}px)`,
          transform: `translate(${-layout.x * 100}%, ${-layout.y * 100}%)`,
        }}
      >
        <div className="work-overlay-header">
          <Button
            variant="quiet"
            size="sm"
            className="work-overlay-handle"
            ref={handle}
            style={{ touchAction: "none" }}
            aria-label="Move command window"
            title="Drag to move. Use arrow keys when focused."
            onPointerDown={(event) => {
              if (event.button !== 0 || drag.current) return;
              event.preventDefault();
              event.stopPropagation();
              drag.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                start: layout,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              if (!start || start.id !== event.pointerId) return;
              event.preventDefault();
              event.stopPropagation();
              const next = {
                ...start.start,
                x: Math.max(
                  0,
                  Math.min(1, start.start.x + (event.clientX - start.x) / (availableX || 1)),
                ),
                y: Math.max(
                  0,
                  Math.min(1, start.start.y + (event.clientY - start.y) / (availableY || 1)),
                ),
              };
              latest.current = next;
              setLayout(next);
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const step = event.shiftKey ? 32 : 8;
              save({
                ...layout,
                x: Math.max(
                  0,
                  Math.min(
                    1,
                    layout.x +
                      (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0) /
                        (availableX || 1),
                  ),
                ),
                y: Math.max(
                  0,
                  Math.min(
                    1,
                    layout.y +
                      (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) /
                        (availableY || 1),
                  ),
                ),
              });
            }}
          >
            <Glyph size={18} />
            <span className="work-overlay-heading">Work</span>
            <span
              className="work-overlay-state"
              data-live={(working && transcript.background) || undefined}
            >
              {working && transcript.background ? "Live" : "Recent"}
            </span>
          </Button>
          <IconButton
            size={28}
            className="work-overlay-toggle"
            label="Hide commands"
            icon="x"
            onClick={() => save({ ...layout, hidden: true })}
          />
        </div>
        <div className="work-overlay-body">
          <section
            className="work-overlay-output"
            ref={output}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling of the command transcript.
            tabIndex={0}
            aria-label="Recent command output"
            onScroll={(event) => {
              const node = event.currentTarget;
              follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
            }}
          >
            {transcript.entries.map((entry) => (
              <div className="work-overlay-entry" key={entry.id}>
                <div className="work-overlay-entry-heading">
                  <span className="work-overlay-kind">{entry.kind}</span>
                  <span className="work-overlay-result" data-status={entry.status}>
                    {entry.status === "ok"
                      ? "Finished"
                      : entry.status === "failed"
                        ? "Failed"
                        : entry.status === "cancelled"
                          ? "Cancelled"
                          : entry.status === "blocked"
                            ? "Blocked"
                            : working
                              ? "Running"
                              : "Stopped"}
                    {entry.exitCode !== undefined &&
                      entry.exitCode !== 0 &&
                      ` · Exit ${entry.exitCode}`}
                  </span>
                  {entry.intent && entry.intent !== entry.title && (
                    <p className="work-overlay-intent">{entry.intent}</p>
                  )}
                  <p className="work-overlay-command" title={entry.title}>
                    {entry.title}
                  </p>
                </div>
                {entry.text ? (
                  <pre>{entry.text}</pre>
                ) : (
                  <p className="work-overlay-empty">
                    {entry.status ? "No output." : "Waiting for output…"}
                  </p>
                )}
                {entry.shortened && (
                  <p className="work-overlay-empty">Recent output shown. More in Activity.</p>
                )}
              </div>
            ))}
          </section>
        </div>
      </section>
    </div>
  );
}

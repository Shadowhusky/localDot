import { useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { ReplayImage } from "./ReplayImage.tsx";

export function CompareView({
  api,
  sessionId,
  frames,
  label,
  onClose,
}: {
  api: ApiClient;
  sessionId: string;
  frames: { before: string | null; after: string | null };
  // The step being compared.
  label?: string;
  onClose(): void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50);
  const locate = (clientX: number) => {
    const bounds = panel.current?.getBoundingClientRect();
    if (bounds?.width)
      setPosition(Math.max(0, Math.min(100, (100 * (clientX - bounds.left)) / bounds.width)));
  };
  return (
    <section className="replay-compare" aria-label="Before and after comparison">
      <header className="replay-compare-head">
        <p className="replay-compare-title">
          {label && <span className="replay-compare-step">{label}</span>}
          <span>Before → After</span>
        </p>
        <IconButton label="Close comparison" icon="x" kbd={["Escape"]} onClick={onClose} />
      </header>
      <div
        ref={panel}
        className="replay-compare-images"
        role="slider"
        tabIndex={0}
        aria-label="Comparison divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${Math.round(position)} percent before`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          locate(event.clientX);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) locate(event.clientX);
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          locate(event.clientX);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          setPosition((value) =>
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? 100
                : Math.max(0, Math.min(100, value + (event.key === "ArrowLeft" ? -1 : 1))),
          );
        }}
      >
        <ReplayImage
          api={api}
          sessionId={sessionId}
          frameId={frames.after}
          full
          alt="Screen after this step"
        />
        <div
          className="replay-compare-before"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        >
          <ReplayImage
            api={api}
            sessionId={sessionId}
            frameId={frames.before}
            full
            alt="Screen before this step"
          />
        </div>
        <div className="replay-compare-divider" style={{ left: `${position}%` }}>
          <span className="replay-compare-handle" aria-hidden="true">
            <Icon name="chevron-left" size={12} />
            <Icon name="chevron-right" size={12} />
          </span>
        </div>
        <span className="replay-compare-label before">Before</span>
        <span className="replay-compare-label after">After</span>
        {!frames.before && !frames.after && (
          <p className="replay-compare-empty">No screenshots for this step.</p>
        )}
      </div>
    </section>
  );
}

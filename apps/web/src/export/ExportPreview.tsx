import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "../ui/IconButton.tsx";
import { Range } from "../ui/Range.tsx";
import { pictureHeight } from "./dot-band.ts";
import type { ExportContext } from "./export-context.ts";
import type { ExportPlan, ExportRequest } from "./export-plan.ts";
import { initialPreview, PreviewPlayer } from "./preview-player.ts";
import { trimTimeLabel } from "./trim.ts";

export function ExportPreview({
  context,
  request,
  plan,
  active,
  held,
  children,
}: {
  context: ExportContext;
  request: ExportRequest;
  plan: ExportPlan | null;
  active: boolean;
  held: boolean;
  children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const player = useRef<PreviewPlayer | null>(null);
  const [state, setState] = useState(initialPreview);
  const dispose = useCallback(() => {
    player.current?.close();
    player.current = null;
  }, []);
  useEffect(() => {
    if (!active) {
      dispose();
      setState(initialPreview());
    }
  }, [active, dispose]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) player.current?.pause();
    };
    const leave = () => {
      dispose();
      setState(initialPreview());
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      dispose();
    };
  }, [dispose]);
  const ensure = () => {
    if (!plan || !surface.current || !active) return null;
    if (state.error) dispose();
    if (!player.current) {
      setState(initialPreview());
      try {
        player.current = new PreviewPlayer(surface.current, context, request, plan, setState);
      } catch {
        setState({ ...initialPreview(), error: true });
      }
    }
    return player.current;
  };
  const reason = !active
    ? "Finish adjusting the range"
    : !plan
      ? "Nothing was recorded in this range"
      : undefined;
  const duration = (plan?.durationS ?? 0) * 1000;
  return (
    <>
      <div
        className="export-preview"
        data-dot={request.dot ?? "off"}
        data-held={held ? "" : undefined}
        style={
          {
            "--preview-picture-ratio": `${request.size.w} / ${pictureHeight(request)}`,
          } as React.CSSProperties
        }
      >
        {children}
        <div
          ref={surface}
          className="export-preview-surface"
          data-visible={state.visible ? "" : undefined}
        />
      </div>
      <div className="export-preview-controls">
        <IconButton
          size={36}
          round
          label={state.playing ? "Pause preview" : state.error ? "Retry preview" : "Play preview"}
          icon={state.playing ? "pause" : "play"}
          disabledReason={reason}
          onClick={() => {
            if (state.playing) player.current?.pause();
            else ensure()?.play();
          }}
        />
        <Range
          className="export-preview-seek"
          label="Preview position"
          aria-valuetext={`${trimTimeLabel(state.positionMs)} of ${trimTimeLabel(duration)}`}
          min={0}
          max={duration}
          step={plan ? 1000 / plan.fps : 1}
          value={state.positionMs}
          disabledReason={reason}
          onValueChange={(value) => ensure()?.seek(value)}
        />
        <span
          className="export-preview-clock num"
          role="timer"
          aria-live="off"
          aria-label="Preview time"
        >
          {trimTimeLabel(state.positionMs)} / {trimTimeLabel(duration)}
        </span>
      </div>
      {(state.loading || state.error) && (
        <p className="export-preview-note" role="status">
          {state.error ? "The preview couldn’t load. Try again." : "Loading preview…"}
        </p>
      )}
    </>
  );
}

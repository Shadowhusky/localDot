import type { RefObject } from "react";
import "@app/shell/hud.css";
import { clock } from "@app/agent/activity.ts";
import { Button } from "@app/ui/Button.tsx";
import { IconButton } from "@app/ui/IconButton.tsx";
import { useLayoutEffect, useRef } from "react";
import { t } from "../i18n.ts";

// The app's HUD island over the Theatre, for a recording: what dot is doing, how long the task had
// been going, and an honest Replay pill with the speed this part plays at.
export function SiteIsland({
  shown,
  label,
  elapsedMs,
  speed,
  playing,
  onToggle,
  phone,
  yours,
  onHandBack,
  noticesRef,
}: {
  shown: boolean;
  label: string;
  elapsedMs: number;
  speed: number | null;
  playing: boolean;
  onToggle(): void;
  phone: boolean;
  // Where its notes hang: toasts drop from here, under the island.
  noticesRef?: RefObject<HTMLDivElement | null>;
  yours: boolean;
  onHandBack(): void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const plate = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const r = row.current;
    const p = plate.current;
    if (!r || !p) return;
    const match = () => {
      p.style.width = `${r.offsetWidth}px`;
    };
    match();
    const observer = new ResizeObserver(match);
    observer.observe(r);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="island-anchor">
      <div className="island" data-shape={shown ? "task" : "hidden"} inert={!shown}>
        <span className="island-plate" ref={plate} aria-hidden="true" />
        <div className="island-row" ref={row}>
          <span className="island-label">
            <span className="island-label-text">
              <span className="island-text-current">{label}</span>
            </span>
          </span>
          <span className="island-elapsed num" role="timer" aria-label={t("Time into the task")}>
            {clock(elapsedMs)}
          </span>
          <span className="island-controls">
            <span className="island-divider" aria-hidden="true" />
            {yours ? (
              <Button
                className="island-action"
                variant="primary"
                round
                size="md"
                icon="hand-back"
                onClick={onHandBack}
              >
                {t("Hand back")}
              </Button>
            ) : (
              <>
                <span className="site-speed num" title={t("A recording of a real task, sped up")}>
                  {speed === null ? t("Replay") : `${t("Replay")} ${speed}×`}
                </span>
                <IconButton
                  variant="glass"
                  size={phone ? 28 : 32}
                  icon={playing ? "pause" : "play"}
                  label={playing ? t("Pause") : t("Play")}
                  onClick={onToggle}
                />
              </>
            )}
          </span>
        </div>
      </div>
      <div className="island-notices" ref={noticesRef} />
    </div>
  );
}

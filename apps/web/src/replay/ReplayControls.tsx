import { REPLAY_SPEEDS } from "@localdot/stage";
import { useId } from "react";
import { exportSupport } from "../export/sink.ts";
import { speedLabel, timeLabel } from "./replay-view.ts";
import type { ReplayState } from "./useReplay.ts";

export function ReplayControls({
  replay,
  onExport,
}: {
  replay: ReplayState;
  onExport?: (anchor: HTMLButtonElement) => void;
}) {
  const label = speedLabel(replay.speed, replay.idleNow);
  const support = exportSupport();
  const exportNote = useId();
  return (
    <fieldset className="replay-controls" aria-label="Playback controls">
      <button
        type="button"
        aria-label="Previous step"
        disabled={!replay.map}
        onClick={() => replay.run({ kind: "step", dir: -1 })}
      >
        Previous
      </button>
      <button
        type="button"
        disabled={!replay.map}
        aria-label={replay.playing ? "Pause replay" : "Play replay"}
        onClick={() => replay.run({ kind: "toggle-play" })}
      >
        {replay.playing ? "Pause" : "Play"}
      </button>
      <button
        type="button"
        aria-label="Next step"
        disabled={!replay.map}
        onClick={() => replay.run({ kind: "step", dir: 1 })}
      >
        Next
      </button>
      <output className="replay-time" aria-label="Replay time">
        {timeLabel(replay.tMs)} / {timeLabel(replay.map?.endMs ?? 0)}
      </output>
      <label>
        Speed{" "}
        <select
          aria-label="Playback speed"
          value={replay.speed}
          onChange={(event) => {
            const speed = REPLAY_SPEEDS.find((value) => value === Number(event.target.value));
            if (speed !== undefined) replay.setSpeed(speed);
          }}
        >
          {REPLAY_SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed === 0.5 ? "½" : speed}×
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={replay.skipIdle}
          onChange={(event) => replay.setSkipIdle(event.target.checked)}
        />{" "}
        Skip idle
      </label>
      <button
        type="button"
        disabled={!replay.model.steps.length}
        aria-pressed={replay.compare !== null}
        onClick={() => replay.run({ kind: "compare" })}
      >
        Before / after
      </button>
      {onExport && (
        <button
          type="button"
          disabled={!replay.map || !replay.info}
          aria-disabled={!support.ok || undefined}
          aria-describedby={support.ok ? undefined : exportNote}
          onClick={(event) => {
            if (support.ok) onExport(event.currentTarget);
          }}
        >
          Export MP4
        </button>
      )}
      {onExport && !support.ok && (
        <span id={exportNote} className="replay-export-note">
          {support.reason}
        </span>
      )}
      <span className="replay-speed-label" role="status">
        {label}
      </span>
    </fieldset>
  );
}

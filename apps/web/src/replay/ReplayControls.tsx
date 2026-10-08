import { REPLAY_SPEEDS } from "@localdot/stage";
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
          onClick={(event) => onExport(event.currentTarget)}
        >
          Export MP4
        </button>
      )}
      <span className="replay-speed-label" role="status">
        {label}
      </span>
    </fieldset>
  );
}

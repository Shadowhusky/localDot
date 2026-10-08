import { REPLAY_SPEEDS } from "@localdot/stage";
import type { ReactNode } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { speedLabel, timeLabel } from "./replay-view.ts";
import type { ReplayState } from "./useReplay.ts";

const SPEEDS = REPLAY_SPEEDS.map((speed) => ({
  value: String(speed),
  label: `${speed === 0.5 ? "½" : speed}×`,
}));
export const LOADING = "The recording is still loading";

export function ReplayControls({
  replay,
  label,
  noVideo = false,
  exportControl,
}: {
  replay: ReplayState;
  // What is happening at the playhead.
  label: string;
  // The recording has no video; the card that said so has gone.
  noVideo?: boolean;
  exportControl?: ReactNode;
}) {
  const loading = replay.map ? undefined : LOADING;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would draw a frame and claim min-content width.
    <div className="replay-transport" role="group" aria-label="Playback controls">
      <div className="replay-transport-main">
        <IconButton
          label="Previous step"
          icon="skip-back"
          kbd={["ArrowLeft"]}
          disabledReason={loading}
          onClick={() => replay.run({ kind: "step", dir: -1 })}
        />
        <IconButton
          variant="primary"
          size={36}
          label={replay.playing ? "Pause replay" : "Play replay"}
          icon={replay.playing ? "pause" : "play"}
          kbd={[" "]}
          disabledReason={loading}
          onClick={() => replay.run({ kind: "toggle-play" })}
        />
        <IconButton
          label="Next step"
          icon="skip-forward"
          kbd={["ArrowRight"]}
          disabledReason={loading}
          onClick={() => replay.run({ kind: "step", dir: 1 })}
        />
        <output className="replay-time num" aria-label="Replay time">
          {timeLabel(replay.tMs)} / {timeLabel(replay.map?.endMs ?? 0)}
        </output>
        <span className="replay-now">
          <span className="replay-now-label">{label}</span>
          {replay.idleNow && <span className="replay-now-idle">Idle skipped</span>}
        </span>
      </div>
      <div className="replay-transport-side">
        {noVideo && <Badge className="replay-no-video">No video</Badge>}
        <span className="replay-speed">
          <Select
            aria-label="Playback speed"
            value={String(replay.speed)}
            items={SPEEDS}
            onValueChange={(value) => {
              const speed = REPLAY_SPEEDS.find((speed) => String(speed) === value);
              if (speed !== undefined) replay.setSpeed(speed);
            }}
          />
        </span>
        <span className="replay-skip">
          <Switch
            label="Skip idle"
            checked={replay.skipIdle}
            onCheckedChange={(checked) => replay.setSkipIdle(checked)}
          />
        </span>
        <span className="replay-toggle" data-on={replay.compare ? "" : undefined}>
          <Button
            variant="quiet"
            aria-pressed={replay.compare !== null}
            disabledReason={replay.model.steps.length ? undefined : "No steps to compare yet"}
            onClick={() => replay.run({ kind: "compare" })}
          >
            Compare
          </Button>
        </span>
        {exportControl}
      </div>
      <VisuallyHidden className="replay-speed-label" role="status">
        {speedLabel(replay.speed, replay.idleNow)}
      </VisuallyHidden>
    </div>
  );
}

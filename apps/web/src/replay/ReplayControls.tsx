import { REPLAY_SPEEDS } from "@localdot/stage";
import type { ReactNode } from "react";
import type { ApiClient } from "../lib/api.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Select } from "../ui/Select.tsx";
import { VisuallyHidden } from "../ui/VisuallyHidden.tsx";
import { speedLabel, timeLabel } from "./replay-view.ts";
import { Scrubber } from "./Scrubber.tsx";
import type { ReplayState } from "./useReplay.ts";

const SPEEDS = REPLAY_SPEEDS.map((speed) => ({
  value: String(speed),
  label: `${speed === 0.5 ? "½" : speed}×`,
}));
export const LOADING = "The recording is still loading";
const SKIP_MS = 10_000;

// The transport (design-v2 §10.23): a glass bar hung over the foot of the recording, with the
// scrubber between the time played and the whole length. A phone keeps play, the scrubber and the
// no-video chip.
export function ReplayControls({
  api,
  replay,
  compact = false,
  noVideo = false,
  cardShown = false,
  viewControl,
  exportControl,
}: {
  api: ApiClient;
  replay: ReplayState;
  compact?: boolean;
  // The recording has no video. Its chip keeps its room from the start and shows once the card
  // that said so (`cardShown`) has gone, so nothing in the bar moves when it does.
  noVideo?: boolean;
  cardShown?: boolean;
  // Work / Screen and any fixed recording overrides; phones place this above the picture.
  viewControl?: ReactNode;
  exportControl?: ReactNode;
}) {
  const loading = replay.map ? undefined : LOADING;
  const size = compact ? 28 : 36;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would draw a frame and claim min-content width.
    <div
      className="replay-transport"
      role="group"
      aria-label="Playback controls"
      data-compact={compact ? "" : undefined}
    >
      {!compact && (
        <IconButton
          variant="glass"
          round
          size={size}
          label="Back 10 seconds"
          icon="back-10"
          kbd={["J"]}
          disabledReason={loading}
          onClick={() => replay.run({ kind: "jump", ms: -SKIP_MS })}
        />
      )}
      <IconButton
        variant="glass"
        round
        size={size}
        label={replay.playing ? "Pause replay" : "Play replay"}
        icon={replay.playing ? "pause" : "play"}
        kbd={[" "]}
        disabledReason={loading}
        onClick={() => replay.run({ kind: "toggle-play" })}
      />
      {!compact && (
        <IconButton
          variant="glass"
          round
          size={size}
          label="Forward 10 seconds"
          icon="forward-10"
          kbd={["L"]}
          disabledReason={loading}
          onClick={() => replay.run({ kind: "jump", ms: SKIP_MS })}
        />
      )}
      <output className="replay-time num" aria-label="Replay time">
        {timeLabel(replay.tMs)}
      </output>
      {replay.sessionId && <Scrubber api={api} sessionId={replay.sessionId} replay={replay} />}
      <span className="replay-length num">{timeLabel(replay.map?.endMs ?? 0)}</span>
      {compact && noVideo && <NoVideo held={cardShown} />}
      {compact && exportControl}
      {!compact && (
        <span className="replay-transport-side">
          {viewControl}
          <Select
            className="replay-speed"
            appearance="inline"
            aria-label="Playback speed"
            value={String(replay.speed)}
            items={SPEEDS}
            onValueChange={(value) => {
              const speed = REPLAY_SPEEDS.find((speed) => String(speed) === value);
              if (speed !== undefined) replay.setSpeed(speed);
            }}
          />
          <Button
            variant="quiet"
            size="sm"
            className="replay-toggle"
            aria-pressed={replay.skipIdle}
            onClick={() => replay.setSkipIdle(!replay.skipIdle)}
          >
            <span className="replay-toggle-label">Skip idle</span>
          </Button>
          <Button
            variant="quiet"
            size="sm"
            className="replay-toggle"
            aria-pressed={replay.compare !== null}
            disabledReason={replay.model.steps.length ? undefined : "No steps to compare yet"}
            onClick={() => replay.run({ kind: "compare" })}
          >
            <span className="replay-toggle-label">Compare</span>
          </Button>
          {noVideo && <NoVideo held={cardShown} />}
          {exportControl}
        </span>
      )}
      <VisuallyHidden className="replay-speed-label" role="status">
        {speedLabel(replay.speed, replay.idleNow)}
      </VisuallyHidden>
    </div>
  );
}

function NoVideo({ held }: { held: boolean }) {
  return (
    <span className="replay-no-video" data-held={held || undefined}>
      <Badge>No video</Badge>
    </span>
  );
}

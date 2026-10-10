import { memo, type ReactNode, type Ref } from "react";
import type { KeyStatus } from "../keys/useKeys.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { SegmentedControl, type SegmentItem } from "../ui/SegmentedControl.tsx";
import "./bar.css";

export type Mode = "watch" | "replay";

export interface TopBarProps {
  // Left out before there is anything to name, as on a first run.
  title?: string;
  // Said after the title, quieter: where a recording comes from.
  note?: string;
  // Before the modes: what the stage's content offers, such as Continue on a recording.
  lead?: ReactNode;
  mode: Mode;
  // While Replay shows, the live task needs you: Watch carries the amber point.
  watchAttention?: boolean;
  replayEnabled: boolean;
  onMode(mode: Mode): void;
  // The chosen mode pressed again, such as Replay while a recording plays.
  onModeAgain?(): void;
  keys: KeyStatus;
  keysOpen: boolean;
  onKeys(): void;
  keysRef?: Ref<HTMLButtonElement>;
  settingsOpen: boolean;
  onSettings(trigger: HTMLButtonElement): void;
  settingsRef?: Ref<HTMLButtonElement>;
  // At the very end: what has no place of its own, such as Stop everything.
  more?: ReactNode;
  panels?: ReactNode;
}

// The wordmark and what is on the stage, then the modes, Settings and Keys. It redraws only when one
// of these changes, never with the task.
export const TopBar = memo(function TopBar({
  title,
  note,
  lead,
  mode,
  watchAttention = false,
  replayEnabled,
  onMode,
  onModeAgain,
  keys,
  keysOpen,
  onKeys,
  keysRef,
  settingsOpen,
  onSettings,
  settingsRef,
  more,
  panels,
}: TopBarProps) {
  const modes: SegmentItem[] = [
    { value: "watch", label: "Watch", attention: watchAttention },
    {
      value: "replay",
      label: "Replay",
      ...(replayEnabled ? {} : { disabledReason: "No recordings yet" }),
    },
  ];
  return (
    <header className="bar">
      <div className="bar-l">
        <span className="bar-wordmark">localDot</span>
        {title && (
          <>
            <span className="bar-sep" aria-hidden="true" />
            <span key={title} className="bar-title">
              {title}
            </span>
          </>
        )}
        {note && <span className="title-note">{note}</span>}
      </div>
      <div className="bar-r">
        {lead}
        {panels}
        <SegmentedControl
          className="bar-modes"
          aria-label="Mode"
          size={28}
          items={modes}
          value={mode}
          onValueChange={(value) => onMode(value as Mode)}
          onReselect={onModeAgain}
        />
        <IconButton
          ref={settingsRef}
          size={32}
          icon="settings"
          label="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          aria-controls="settings-sheet"
          onClick={(event) => onSettings(event.currentTarget)}
        />
        <IconButton
          ref={keysRef}
          size={32}
          icon="key-round"
          label={keys.spoken ?? keys.label}
          attention={keys.state !== "ok" && keys.state !== "unknown"}
          aria-haspopup="dialog"
          aria-expanded={keysOpen}
          aria-controls="keys-sheet"
          data-testid="keys-button"
          data-state={keys.state}
          onClick={onKeys}
        />
        {more}
      </div>
    </header>
  );
});

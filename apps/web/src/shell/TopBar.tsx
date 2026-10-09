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
}

// The wordmark and what is on the stage; the empty centre the island rises into; then the modes,
// Settings and Keys. It redraws only when one of these changes, never with the task.
export const TopBar = memo(function TopBar({
  title,
  note,
  lead,
  mode,
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
}: TopBarProps) {
  const modes: SegmentItem[] = [
    { value: "watch", label: "Watch" },
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
            <span className="bar-title">{title}</span>
          </>
        )}
        {note && <span className="title-note">{note}</span>}
      </div>
      <div className="bar-r">
        {lead}
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
          attention={keys.state === "offline" || keys.state === "audit" || keys.state === "guard"}
          aria-haspopup="dialog"
          aria-expanded={keysOpen}
          aria-controls="keys-sheet"
          data-testid="keys-button"
          data-state={keys.state}
          onClick={onKeys}
        />
      </div>
    </header>
  );
});

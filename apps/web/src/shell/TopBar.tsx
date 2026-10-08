import type { Ref } from "react";
import type { KeyStatus } from "../keys/useKeys.ts";
import { Mascot } from "./Mascot.tsx";

export interface TopBarProps {
  title: string;
  live: boolean;
  keys: KeyStatus;
  keysOpen: boolean;
  onKeys(): void;
  keysRef?: Ref<HTMLButtonElement>;
  mode?: "watch" | "replay";
  replayEnabled?: boolean;
  onMode?(mode: "watch" | "replay"): void;
  settings?: { open: boolean; run(trigger: HTMLButtonElement): void; ref?: Ref<HTMLButtonElement> };
}

export function TopBar({
  title,
  live,
  keys,
  keysOpen,
  onKeys,
  keysRef,
  settings,
  mode = "watch",
  replayEnabled = false,
  onMode,
}: TopBarProps) {
  const alert = keys.state === "offline" || keys.state === "audit" || keys.state === "guard";
  return (
    <header className="bar">
      <div className="bar-l">
        <span className="brand">
          <Mascot />
          localDot
        </span>
        <span className="title">{title}</span>
      </div>
      <nav className="modes" aria-label="Mode">
        <span aria-disabled="true">Glance</span>
        <button
          type="button"
          className={mode === "watch" ? "on" : undefined}
          aria-current={mode === "watch" ? "page" : undefined}
          onClick={() => onMode?.("watch")}
        >
          Watch
        </button>
        <button
          type="button"
          className={mode === "replay" ? "on" : undefined}
          aria-current={mode === "replay" ? "page" : undefined}
          disabled={!replayEnabled}
          title={replayEnabled ? undefined : "No sessions yet"}
          onClick={() => onMode?.("replay")}
        >
          Replay
        </button>
      </nav>
      <div className="bar-r">
        {settings && (
          <button
            ref={settings.ref}
            type="button"
            className="keys-btn"
            aria-haspopup="dialog"
            aria-expanded={settings.open}
            aria-controls="settings-sheet"
            onClick={(event) => settings.run(event.currentTarget)}
          >
            Settings
          </button>
        )}
        <button
          ref={keysRef}
          type="button"
          className={alert ? "keys-btn alert" : "keys-btn"}
          aria-label={keys.spoken}
          aria-haspopup="dialog"
          aria-expanded={keysOpen}
          aria-controls="keys-sheet"
          onClick={onKeys}
          data-testid="keys-button"
        >
          <span className="dot" aria-hidden="true" />
          {keys.label}
        </button>
        <span className={live ? "live on" : "live"}>
          <b aria-hidden="true" />
          {live ? "Live" : "Not live"}
        </span>
      </div>
    </header>
  );
}

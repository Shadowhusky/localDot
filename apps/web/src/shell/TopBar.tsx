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
}

export function TopBar({ title, live, keys, keysOpen, onKeys, keysRef }: TopBarProps) {
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
        <span className="on" aria-current="page">
          Watch
        </span>
        <span aria-disabled="true">Replay</span>
      </nav>
      <div className="bar-r">
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

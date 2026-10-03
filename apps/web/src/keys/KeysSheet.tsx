import { useEffect, useRef, useState } from "react";
import { KeyForm } from "./KeyForm.tsx";
import { KeyList } from "./KeyList.tsx";
import { type KeydHealth, KeyProblem } from "./keys-api.ts";
import { type KeysController, keyStatus } from "./useKeys.ts";
import "./keys.css";

export interface KeysSheetProps {
  open: boolean;
  keys: KeysController;
  onClose(): void;
}

// A modal sheet that grows from the top bar's Keys button and returns to it. It stays mounted so
// opening and closing are one interruptible transition; closed, it is inert.
export function KeysSheet({ open, keys, onClose }: KeysSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const status = keyStatus(keys.health);
  const offline = status.state === "offline";
  const changing = useRef(false);
  const [busy, setBusy] = useState(false);
  // Lock before health lookup or sealing starts. A later Delete must not reach
  // keyd before an earlier Save and then have that Save recreate the key.
  const mutate = async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (changing.current) throw new KeyProblem("Another key change is in progress.");
    changing.current = true;
    setBusy(true);
    try {
      return await operation();
    } finally {
      changing.current = false;
      setBusy(false);
    }
  };
  const disabled = !keys.health?.online || busy;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Tab" && panel.current) keepFocusIn(panel.current, e);
    };
    window.addEventListener("keydown", onKey);
    const initial = panel.current?.querySelector<HTMLElement>(".key-form input:enabled, .x");
    initial?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={open ? "scrim on" : "scrim"} onPointerDown={onClose} aria-hidden="true" />
      <div
        ref={panel}
        id="keys-sheet"
        className={open ? "sheet on" : "sheet"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        aria-hidden={!open}
        inert={!open}
      >
        <header>
          <h2 id="keys-title">Keys</h2>
          <button type="button" className="x" onClick={onClose} aria-label="Close keys">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <p className="lede">
          Your keys stay on this Mac. Apps in your computer get temporary access without seeing the
          real keys.
        </p>
        {offline && (
          <p className="keys-note" role="alert">
            The key layer is offline. Start keyd, then come back here.
          </p>
        )}
        {status.state === "audit" && (
          <p className="keys-note" role="alert">
            keyd can't write its audit log, so it holds every key back until it can
            {keys.health?.audit?.error ? `: ${keys.health.audit.error}` : "."}
          </p>
        )}
        {keys.loadError && !offline && (
          <p className="keys-note" role="alert">
            {keys.loadError}
          </p>
        )}
        {!offline && keys.health && <HairpinLine guard={keys.health.hairpin} />}
        <KeyList
          active={open}
          keys={keys.keys}
          disabled={disabled}
          remove={(id) => mutate(() => keys.remove(id))}
        />
        <KeyForm
          active={open}
          disabled={disabled}
          save={(binding, value) => mutate(() => keys.save(binding, value))}
        />
      </div>
    </>
  );
}

// Hairpin NAT: a computer could reach the router's own pages through this network's public
// address, unless keyd knows that address and refuses it.
function HairpinLine({ guard }: { guard: KeydHealth["hairpin"] }) {
  if (guard?.state === "active") {
    return (
      <p className="keys-guard">Hairpin guard: active. Your router's public address is blocked.</p>
    );
  }
  const why =
    guard?.state === "off"
      ? "keyd is set to ask neither your router nor STUN for this network's public address"
      : "keyd hasn't learned this network's public address yet and keeps asking";
  return (
    <p className="keys-note">
      Hairpin guard: {guard?.state === "off" ? "off" : "unknown"}. A computer could reach your
      router through its public address: {why}.
    </p>
  );
}

// aria-modal: Tab and Shift-Tab go round the sheet's own controls.
function keepFocusIn(panel: HTMLElement, e: KeyboardEvent) {
  const items = [
    ...panel.querySelectorAll<HTMLElement>("button:enabled, input:enabled, select:enabled"),
  ];
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) return;
  const inside = panel.contains(document.activeElement);
  if (e.shiftKey && (!inside || document.activeElement === first)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
    e.preventDefault();
    first.focus();
  }
}

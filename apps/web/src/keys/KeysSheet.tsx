import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ownedByPicker } from "../lib/dismiss.ts";
import { KeyForm, type KeyFormPreset, type KeyIntake } from "./KeyForm.tsx";
import { KeyList } from "./KeyList.tsx";
import { type KeydHealth, KeyProblem, type KeyRecord } from "./keys-api.ts";
import { type KeysController, keyStatus } from "./useKeys.ts";
import "./keys.css";

export interface KeysSheetProps {
  open: boolean;
  keys: KeysController;
  onClose(): void;
  stop?: { readonly label: string; readonly enabled: boolean; run(): void };
  intakeRef?: Ref<KeyIntake>;
  preset?: KeyFormPreset;
  onSaved?(key: KeyRecord, requestId: number): void;
  taskControls?: ReactNode;
}

// A modal sheet that grows from the top bar's Keys button and returns to it. It stays mounted so
// opening and closing are one interruptible transition; closed, it is inert.
export function KeysSheet({
  open,
  keys,
  onClose,
  stop,
  intakeRef,
  preset,
  onSaved,
  taskControls,
}: KeysSheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const status = keyStatus(keys.health);
  const offline = status.state === "offline";
  const changing = useRef(false);
  const [busy, setBusy] = useState(false);
  const owner = useRef({ open, preset, onSaved, generation: 0 });
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      owner.current.open = false;
      owner.current.generation++;
    };
  }, []);
  useLayoutEffect(() => {
    if (owner.current.open !== open || owner.current.preset !== preset) owner.current.generation++;
    Object.assign(owner.current, { open, preset, onSaved });
  }, [open, preset, onSaved]);
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
      if (mounted.current) setBusy(false);
    }
  };
  const disabled = !keys.health?.online || busy;
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open)
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    else setConfirming(false);
  }, [open]);
  useEffect(() => {
    if (open) return;
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected && !target.closest("[inert], [hidden]")) target.focus();
  }, [open]);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  // A typed key exists only in its field, so closing would lose it without a word.
  const requestClose = useCallback(() => {
    const typed = panel.current?.querySelector<HTMLInputElement>(".key-form input.secret")?.value;
    if (!typed) return onClose();
    setConfirming(true);
    keep.current?.focus();
  }, [onClose]);
  const keepEditing = useCallback(() => {
    setConfirming(false);
    panel.current?.querySelector<HTMLElement>(".key-form input.secret")?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ownedByPicker(e)) {
        e.preventDefault();
        if (keep.current) keepEditing();
        else requestClose();
      }
      if (e.key === "Tab" && panel.current) keepFocusIn(panel.current, e);
    };
    window.addEventListener("keydown", onKey);
    const initial = panel.current?.querySelector<HTMLElement>(".key-form input:enabled, .x");
    initial?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, requestClose, keepEditing]);

  return (
    <>
      <div
        className={open ? "scrim on" : "scrim"}
        onClick={(e) => {
          if (e.target === e.currentTarget) requestClose();
        }}
        aria-hidden="true"
      />
      <div
        ref={panel}
        id="keys-sheet"
        className={open ? "sheet on" : "sheet"}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        aria-hidden={!open}
        inert={!open}
        onSubmit={() => setConfirming(false)}
      >
        <header>
          <h2 id="keys-title">Keys</h2>
          <button type="button" className="x" onClick={requestClose} aria-label="Close keys">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {stop && (
          <div className="sheet-task-control">
            <span>Computer controls</span>
            <button
              type="button"
              className="sheet-stop"
              aria-disabled={!stop.enabled || undefined}
              onClick={() => {
                if (stop.enabled) stop.run();
              }}
            >
              {stop.label}
            </button>
          </div>
        )}
        {open && taskControls}
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
          intakeRef={intakeRef}
          active={open}
          disabled={disabled}
          preset={preset}
          save={(binding, value) => {
            const generation = owner.current.generation,
              request = owner.current.preset?.requestId;
            return mutate(async () => {
              const result = await keys.save(binding, value);
              if (
                result.key &&
                request !== undefined &&
                owner.current.open &&
                owner.current.generation === generation &&
                owner.current.preset?.requestId === request
              )
                owner.current.onSaved?.(result.key, request);
              return result;
            });
          }}
        />
        {confirming && (
          <div className="keys-discard">
            <p role="alert">Discard the key you entered?</p>
            <div>
              <button ref={keep} type="button" onClick={keepEditing}>
                Keep editing
              </button>
              <button type="button" onClick={onClose}>
                Discard
              </button>
            </div>
          </div>
        )}
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

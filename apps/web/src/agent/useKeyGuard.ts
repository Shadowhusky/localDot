import { KEY_SCAN_MATCHES, type KeyMatch, scanKeyLike } from "@localdot/protocol";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface KeyNotice {
  readonly kind: "found" | "overflow" | "transfer_failed";
  readonly candidates: readonly KeyMatch[];
}
export interface KeyGuard {
  readonly notice: KeyNotice | null;
  // Call on input/paste and again before copying text to delivery state or a request.
  check(field: HTMLTextAreaElement): boolean;
  edit(): void;
  remove(): void;
  cancel(): void;
  move(
    index: number,
    receive: (source: HTMLInputElement, provider?: KeyMatch["provider"]) => boolean,
  ): boolean;
}
function withoutKeys(text: string, matches: readonly KeyMatch[]): string {
  let clean = text;
  for (const match of [...matches].reverse())
    clean = clean.slice(0, match.start) + clean.slice(match.end);
  return clean;
}

// The ordinary draft and detected candidates have imperative DOM owners. React sees only
// bounded positions/provider hints; no secret string prop, state, context or ref queue exists.
export function useKeyGuard(active = true): KeyGuard {
  const [notice, setNotice] = useState<KeyNotice | null>(null);
  const current = useRef<KeyNotice | null>(null);
  const owner = useRef<HTMLTextAreaElement | null>(null);
  const available = useRef(active);
  const moving = useRef(false);
  const inputs = useMemo(
    () =>
      Array.from({ length: KEY_SCAN_MATCHES }, () => {
        const input = document.createElement("input");
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
        return input;
      }),
    [],
  );
  const publish = (value: KeyNotice | null) => {
    current.current = value;
    setNotice(value);
  };
  const clear = useCallback(
    (notify = true) => {
      for (const input of inputs) input.value = "";
      const field = owner.current;
      if (field) {
        const scan = scanKeyLike(field.value);
        field.value = scan.overflow ? "" : withoutKeys(field.value, scan.matches);
      }
      current.current = null;
      if (notify) setNotice(null);
    },
    [inputs],
  );
  useLayoutEffect(() => {
    available.current = active && !document.hidden;
    if (!active) clear();
    const hide = () => {
      available.current = false;
      clear();
    };
    const visible = () => {
      if (document.hidden) hide();
      else available.current = active;
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      available.current = false;
      clear(false);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, clear]);
  return {
    notice,
    check(field) {
      if (!available.current || document.hidden || !field.isConnected) {
        clear();
        // A forged input after close/hide may target a field this owner never admitted.
        const scan = scanKeyLike(field.value);
        field.value = scan.overflow ? "" : withoutKeys(field.value, scan.matches);
        return false;
      }
      if (owner.current && owner.current !== field) clear();
      owner.current = field;
      let raw = field.value;
      const scan = scanKeyLike(raw);
      if (!scan.overflow && scan.matches.length === 0) return current.current === null;
      for (const input of inputs) input.value = "";
      try {
        // Remove the recognised text before publishing even non-sensitive React metadata.
        field.value = scan.overflow ? "" : withoutKeys(raw, scan.matches);
        if (!scan.overflow)
          for (const [index, match] of scan.matches.entries()) {
            const input = inputs[index];
            if (input) input.value = raw.slice(match.start, match.end);
          }
        publish({
          kind: scan.overflow ? "overflow" : "found",
          candidates: scan.overflow ? [] : scan.matches,
        });
      } finally {
        raw = "";
      }
      return false;
    },
    edit() {
      if (available.current && !document.hidden) owner.current?.focus();
    },
    remove() {
      clear();
      if (available.current && !document.hidden) owner.current?.focus();
    },
    cancel: () => clear(),
    move(index, receive) {
      if (moving.current || !available.current || document.hidden || !owner.current?.isConnected) {
        clear();
        return false;
      }
      const candidate = current.current?.candidates[index];
      const source = inputs[index];
      if (!candidate || !source || current.current?.kind !== "found") return false;
      moving.current = true;
      let received = false;
      try {
        const scan = scanKeyLike(source.value);
        if (
          !scan.overflow &&
          scan.matches.length === 1 &&
          scan.matches[0]?.start === 0 &&
          scan.matches[0]?.end === source.value.length
        )
          received = receive(source, candidate.provider) === true;
      } catch {
        received = false;
      } finally {
        clear();
        moving.current = false;
      }
      if (!received) publish({ kind: "transfer_failed", candidates: [] });
      return received;
    },
  };
}

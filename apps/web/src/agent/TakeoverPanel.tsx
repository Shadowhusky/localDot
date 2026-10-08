import { HandbackRequest, ManualInput } from "@localdot/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import { KeyFound } from "./KeyFound.tsx";
import type { AgentTakeover } from "./model.ts";
import { useKeyGuard } from "./useKeyGuard.ts";
import type { TaskControls } from "./useTaskControls.ts";

export type PointerMode = "click" | "double" | "right";
export function TakeoverPanel({
  takeover,
  controls,
  visible,
  manualStatus,
  receiveKey,
  screen,
  pointerMode,
  onPointerMode,
}: {
  takeover: AgentTakeover;
  controls: TaskControls;
  visible: boolean;
  manualStatus: string | undefined;
  receiveKey: KeyIntake["receive"];
  screen: { w: number; h: number } | null;
  pointerMode: PointerMode;
  onPointerMode(mode: PointerMode): void;
}) {
  const panel = useRef<HTMLElement>(null),
    text = useRef<HTMLInputElement>(null),
    note = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const guard = useKeyGuard(visible),
    guardOwner = useRef(guard);
  const keyNotice = useId();
  const current = useRef({ takeover, controls, visible });
  const clear = () => {
    if (text.current) text.current.value = "";
    composing.current = false;
  };
  useLayoutEffect(() => {
    current.current = { takeover, controls, visible };
    guardOwner.current = guard;
    if (!visible || controls.fenced || !controls.canInput) clear();
  });
  useEffect(() => {
    const field = text.current;
    const clearOwned = () => {
      if (field) field.value = "";
      composing.current = false;
    };
    const hidden = () => {
      if (document.hidden) clearOwned();
    };
    window.addEventListener("blur", clearOwned);
    window.addEventListener("pagehide", clearOwned);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearOwned();
      window.removeEventListener("blur", clearOwned);
      window.removeEventListener("pagehide", clearOwned);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const sendText = () => {
    const now = current.current,
      field = text.current;
    if (!field || !now.visible || !now.controls.canInput || composing.current) return;
    const parsed = ManualInput.safeParse({ kind: "text", text: field.value });
    if (!parsed.success) {
      setProblem("Enter 1–4000 characters of valid text.");
      clear();
      return;
    }
    field.value = ""; // Clear the DOM before the transport closure captures the bounded text.
    setProblem(null);
    void now.controls.input(now.takeover.requestId, parsed.data);
  };
  const handback = () => {
    const now = current.current,
      field = note.current;
    if (!now.visible || !now.controls.canHandback || (field && !guardOwner.current.check(field)))
      return;
    const parsed = HandbackRequest.safeParse({
      requestId: now.takeover.requestId,
      ...(field?.value ? { note: field.value } : {}),
    });
    if (!parsed.success) {
      setProblem("Shorten your note to 1000 characters.");
      return;
    }
    clear();
    if (field) field.value = "";
    guardOwner.current.cancel();
    void now.controls.handback(parsed.data.requestId, parsed.data.note);
  };
  return (
    <section
      ref={panel}
      className="takeover-panel"
      aria-label="Manual control"
      onBlurCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !panel.current?.contains(event.relatedTarget))
          clear();
      }}
    >
      <h3>Your turn · {takeover.reason === "2fa" ? "verification" : takeover.reason}</h3>
      <p>{takeover.note}</p>
      <p className="history-note">
        Click or tap the computer to use it. Text is sent to the computer and cleared after sending.
      </p>
      <fieldset disabled={!visible || !controls.canInput} className="pointer-modes">
        <legend>Pointer</legend>
        {(
          [
            ["click", "Click"],
            ["double", "Double-click"],
            ["right", "Right-click"],
          ] as const
        ).map(([mode, label]) => (
          <button
            type="button"
            key={mode}
            aria-pressed={pointerMode === mode}
            onClick={() => onPointerMode(mode)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <form
        aria-label="Type on the computer"
        onSubmit={(event) => {
          event.preventDefault();
          sendText();
        }}
      >
        <label className="control-field">
          <span>Text for the computer</span>
          <input
            ref={text}
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={8000}
            disabled={!visible || !controls.canInput}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onPaste={(event) => {
              const field = event.currentTarget,
                pasted = event.clipboardData.getData("text/plain");
              event.preventDefault();
              const next =
                field.value.slice(0, field.selectionStart ?? field.value.length) +
                pasted +
                field.value.slice(field.selectionEnd ?? field.value.length);
              if (
                next.length > 8000 ||
                !ManualInput.safeParse({ kind: "text", text: next }).success
              ) {
                clear();
                setProblem("Enter 1–4000 characters of valid text.");
              } else field.value = next;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && !composing.current) {
                event.preventDefault();
                sendText();
              }
            }}
          />
        </label>
        <button type="submit" disabled={!visible || !controls.canInput}>
          Type text
        </button>
      </form>
      <fieldset className="manual-keys">
        <legend>Computer keys</legend>
        {(
          [
            ["tab", "Tab"],
            ["enter", "Return"],
            ["esc", "Escape"],
            ["backspace", "Backspace"],
            ["left", "←"],
            ["right", "→"],
            ["up", "↑"],
            ["down", "↓"],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            disabled={!visible || !controls.canInput}
            aria-label={`Computer ${key}`}
            onClick={() => {
              void current.current.controls.input(current.current.takeover.requestId, {
                kind: "key",
                combo: [key],
              });
            }}
          >
            {label}
          </button>
        ))}
        {([-3, 3] as const).map((dy) => (
          <button
            type="button"
            key={dy}
            disabled={!visible || !controls.canInput || !screen}
            onClick={() => {
              if (screen)
                void current.current.controls.input(current.current.takeover.requestId, {
                  kind: "scroll",
                  at: { x: Math.floor(screen.w / 2), y: Math.floor(screen.h / 2) },
                  dx: 0,
                  dy,
                });
            }}
          >
            Scroll {dy < 0 ? "up" : "down"}
          </button>
        ))}
      </fieldset>
      <label className="control-field">
        <span>Optional note for dot</span>
        <textarea
          ref={note}
          rows={2}
          maxLength={1000}
          disabled={!visible || !controls.canHandback}
          autoComplete="off"
          onInput={(event) => {
            guardOwner.current.check(event.currentTarget);
          }}
          onPaste={(event) => {
            event.preventDefault();
            const field = event.currentTarget,
              text = event.clipboardData.getData("text/plain");
            if (
              field.value.length + text.length - (field.selectionEnd - field.selectionStart) >
              1000
            )
              field.value = " ".repeat(8001);
            else field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
            guardOwner.current.check(field);
          }}
        />
      </label>
      <KeyFound guard={guard} receive={receiveKey} noticeId={keyNotice} />
      <button
        type="button"
        disabled={!visible || !controls.canHandback || !!guard.notice}
        aria-describedby={guard.notice ? keyNotice : undefined}
        onClick={handback}
      >
        Return control to dot
      </button>
      {(manualStatus === "unconfirmed" || manualStatus === "returning") && (
        <p role="status">
          Input or hand-back is still unconfirmed. Agent control remains blocked. Use Stop to
          contain the computer.
        </p>
      )}
      {manualStatus === "waiting" && <p role="status">Preparing manual control…</p>}
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}

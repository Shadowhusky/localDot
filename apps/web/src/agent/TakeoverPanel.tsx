import { HandbackRequest, type ManualStreamInput } from "@localdot/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import type { PointerMode } from "../stage/ManualSurface.tsx";
import { textInputs } from "../stage/manual-keys.ts";
import { Icon } from "../ui/Icon.tsx";
import { KeyFound } from "./KeyFound.tsx";
import type { AgentTakeover } from "./model.ts";
import { useKeyGuard } from "./useKeyGuard.ts";
import type { TaskControls } from "./useTaskControls.ts";

// Input already on its way reaches the computer before dot has it back, unless it takes this long.
const DRAIN_MS = 5000;
const PASTE_LIMIT = 4000;

export function TakeoverPanel({
  takeover,
  controls,
  visible,
  manualStatus,
  receiveKey,
  screen,
  pointerMode,
  onPointerMode,
  send,
  drained,
  typing,
  onKeyboard,
  refused,
}: {
  takeover: AgentTakeover;
  controls: TaskControls;
  visible: boolean;
  manualStatus: string | undefined;
  receiveKey: KeyIntake["receive"];
  screen: { w: number; h: number } | null;
  pointerMode: PointerMode;
  onPointerMode(mode: PointerMode): void;
  send(input: ManualStreamInput): void;
  drained(timeoutMs: number): Promise<boolean>;
  // Keys typed now go to the computer.
  typing: boolean;
  onKeyboard(on: boolean): void;
  refused: string | null;
}) {
  const panel = useRef<HTMLElement>(null),
    text = useRef<HTMLTextAreaElement>(null),
    note = useRef<HTMLTextAreaElement>(null),
    composing = useRef(false),
    returning = useRef(false),
    typingAtPress = useRef<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const guard = useKeyGuard(visible),
    guardOwner = useRef(guard);
  const keyNotice = useId(),
    pasteForm = useId();
  const current = useRef({ takeover, controls, visible, send, drained });
  const live = visible && controls.canInput;
  const clear = () => {
    if (text.current) text.current.value = "";
    composing.current = false;
  };
  useLayoutEffect(() => {
    current.current = { takeover, controls, visible, send, drained };
    guardOwner.current = guard;
    if (!visible || controls.fenced || !controls.canInput) clear();
  });
  useEffect(() => {
    const clearOwned = () => {
      if (text.current) text.current.value = "";
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
  const typeText = (value: string) => {
    const now = current.current;
    clear(); // Clear the DOM before the input leaves for the computer.
    if (!now.visible || !now.controls.canInput || !value) return;
    if ([...value].length > PASTE_LIMIT || !value.isWellFormed() || value.includes("\0")) {
      setProblem("Paste up to 4,000 characters at a time.");
      return;
    }
    setProblem(null);
    for (const input of textInputs(value)) now.send(input);
    setPasting(false);
  };
  const handback = async () => {
    const now = current.current,
      field = note.current;
    if (
      returning.current ||
      !now.visible ||
      !now.controls.canHandback ||
      (field && !guardOwner.current.check(field))
    )
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
    returning.current = true;
    try {
      await now.drained(DRAIN_MS);
      await current.current.controls.handback(parsed.data.requestId, parsed.data.note);
    } finally {
      returning.current = false;
    }
  };
  const shown = problem ?? refused;
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
      <p className="history-note manual-hint">
        <span className="manual-hint-pointer">
          Click the computer, then type: every key goes to it. Press Esc twice to stop typing.
        </span>
        <span className="manual-hint-touch">
          Tap the computer to click on it. Tap Keyboard to type on it.
        </span>
      </p>
      <div className="manual-entry">
        <button
          type="button"
          aria-pressed={typing}
          disabled={!live}
          // Pressing the button takes focus from the keyboard field before its click arrives.
          onPointerDown={() => {
            typingAtPress.current = typing;
          }}
          onClick={() => {
            const was = typingAtPress.current ?? typing;
            typingAtPress.current = null;
            onKeyboard(!was);
          }}
        >
          <Icon name="keyboard" />
          Keyboard
        </button>
        <button
          type="button"
          aria-expanded={pasting}
          aria-controls={pasteForm}
          disabled={!live}
          onClick={() => {
            clear();
            if (pasting) return setPasting(false);
            flushSync(() => setPasting(true));
            text.current?.focus();
          }}
        >
          <Icon name="clipboard-paste" />
          Paste text
        </button>
      </div>
      {pasting && (
        <form
          id={pasteForm}
          aria-label="Paste on the computer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!composing.current) typeText(text.current?.value ?? "");
          }}
        >
          <label className="control-field">
            <span>Text to type on the computer</span>
            <textarea
              ref={text}
              className="manual-paste"
              rows={2}
              autoComplete="off"
              spellCheck={false}
              disabled={!live}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onPaste={(event) => {
                event.preventDefault();
                typeText(event.clipboardData.getData("text/plain"));
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !composing.current
                ) {
                  event.preventDefault();
                  typeText(event.currentTarget.value);
                }
              }}
            />
          </label>
          <button type="submit" disabled={!live}>
            Type it
          </button>
        </form>
      )}
      <fieldset disabled={!live} className="pointer-modes">
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
            disabled={!live}
            aria-label={`Computer ${key}`}
            onClick={() => current.current.send({ kind: "key", combo: [key] })}
          >
            {label}
          </button>
        ))}
        {([-3, 3] as const).map((dy) => (
          <button
            type="button"
            key={dy}
            disabled={!live || !screen}
            onClick={() => {
              if (screen)
                current.current.send({
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
        onClick={() => void handback()}
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
      {shown && <p role="alert">{shown}</p>}
    </section>
  );
}

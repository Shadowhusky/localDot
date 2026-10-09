import { HandbackRequest, type ManualStreamInput } from "@localdot/protocol";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { KeyIntake } from "../keys/KeyForm.tsx";
import type { PointerMode } from "../stage/ManualSurface.tsx";
import { textInputs } from "../stage/manual-keys.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { TextArea } from "../ui/TextArea.tsx";
import { KeyFound } from "./KeyFound.tsx";
import type { AgentTakeover } from "./model.ts";
import { useKeyGuard } from "./useKeyGuard.ts";
import type { TaskControls } from "./useTaskControls.ts";

// Input already on its way reaches the computer before dot has it back, unless it takes this long.
const DRAIN_MS = 5000;
const PASTE_LIMIT = 4000;
const POINTER_MODES = [
  { value: "click", label: "Click" },
  { value: "double", label: "Double-click" },
  { value: "right", label: "Right-click" },
] as const;
const COMPUTER_KEYS = [
  ["tab", "Tab"],
  ["enter", "Return"],
  ["esc", "Escape"],
  ["backspace", "Backspace"],
  ["left", "←"],
  ["right", "→"],
  ["up", "↑"],
  ["down", "↓"],
] as const;
const fieldIn = (form: HTMLFormElement | null) => {
  const field = form?.elements.namedItem("paste");
  return field instanceof HTMLTextAreaElement ? field : null;
};

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
    pasteForm = useRef<HTMLFormElement>(null),
    composing = useRef(false),
    returning = useRef(false),
    typingAtPress = useRef<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const guard = useKeyGuard(visible),
    guardOwner = useRef(guard);
  const keyNotice = useId(),
    pasteFormId = useId();
  const current = useRef({ takeover, controls, visible, send, drained });
  const live = visible && controls.canInput;
  const pasteField = () => fieldIn(pasteForm.current);
  const clear = () => {
    const field = pasteField();
    if (field) field.value = "";
    composing.current = false;
  };
  useLayoutEffect(() => {
    current.current = { takeover, controls, visible, send, drained };
    guardOwner.current = guard;
    if (!visible || controls.fenced || !controls.canInput) clear();
  });
  useEffect(() => {
    const clearOwned = () => {
      const field = fieldIn(pasteForm.current);
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
      field = panel.current?.querySelector<HTMLTextAreaElement>('textarea[name="note"]');
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
  const idle = live ? undefined : "Wait for the computer to be ready";
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
          Click the computer, then type: every key goes to it.
          <br />
          <Kbd keys={["Escape"]} /> twice stops typing. <Kbd keys={["Mod", "V"]} /> pastes from this
          device. <Kbd keys={["Mod", "Shift", "."]} /> stops the task.
        </span>
        <span className="manual-hint-touch">
          Tap the computer to click on it. Tap Keyboard to type on it.
        </span>
      </p>
      <div className="manual-entry">
        <Button
          size="sm"
          icon="keyboard"
          variant={typing ? "secondary" : "quiet"}
          aria-pressed={typing}
          disabledReason={idle}
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
          Keyboard
        </Button>
        <Button
          size="sm"
          icon="clipboard-paste"
          variant={pasting ? "secondary" : "quiet"}
          aria-expanded={pasting}
          aria-controls={pasteFormId}
          disabledReason={idle}
          onClick={() => {
            clear();
            if (pasting) return setPasting(false);
            flushSync(() => setPasting(true));
            pasteField()?.focus();
          }}
        >
          Paste text
        </Button>
        <SegmentedControl
          aria-label="Pointer"
          className="manual-pointer"
          items={POINTER_MODES.map((item) => ({ ...item, disabledReason: idle }))}
          value={pointerMode}
          onValueChange={(mode) => onPointerMode(mode as PointerMode)}
        />
      </div>
      {pasting && (
        <form
          ref={pasteForm}
          id={pasteFormId}
          className="manual-paste-form"
          aria-label="Paste on the computer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!composing.current) typeText(pasteField()?.value ?? "");
          }}
        >
          <Field label="Text to type on the computer" disabledReason={idle}>
            <TextArea
              name="paste"
              className="manual-paste"
              maxRows={4}
              autoComplete="off"
              spellCheck={false}
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
          </Field>
          <Button type="submit" size="sm" disabledReason={idle}>
            Type it
          </Button>
        </form>
      )}
      <fieldset aria-label="Computer keys" className="manual-keys">
        {COMPUTER_KEYS.map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            aria-label={`Computer ${key}`}
            disabledReason={idle}
            onClick={() => current.current.send({ kind: "key", combo: [key] })}
          >
            {label}
          </Button>
        ))}
        {([-3, 3] as const).map((dy) => (
          <Button
            key={dy}
            size="sm"
            disabledReason={idle ?? (screen ? undefined : "Wait for the computer to be ready")}
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
          </Button>
        ))}
      </fieldset>
      <Field
        label="Optional note for dot"
        className="manual-note"
        disabledReason={
          visible && controls.canHandback ? undefined : "Wait for the computer to be ready"
        }
      >
        <TextArea
          name="note"
          maxRows={6}
          maxLength={1000}
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
      </Field>
      <KeyFound guard={guard} receive={receiveKey} noticeId={keyNotice} />
      <Button
        variant="primary"
        className="manual-return"
        disabledReason={
          guard.notice
            ? "Move the key to Keys or discard it first"
            : !visible || !controls.canHandback
              ? "Wait for the computer to be ready"
              : undefined
        }
        aria-describedby={guard.notice ? keyNotice : undefined}
        onClick={() => void handback()}
      >
        Return control to dot
      </Button>
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

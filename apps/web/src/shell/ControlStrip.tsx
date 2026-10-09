import type { ManualStreamInput } from "@localdot/protocol";
import { useEffect, useRef, useState } from "react";
import { textInputs } from "../stage/manual-keys.ts";
import { Button } from "../ui/Button.tsx";
import { Field } from "../ui/Field.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { Popover, triggerProps } from "../ui/Popover.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { TextArea } from "../ui/TextArea.tsx";

const TYPE_LIMIT = 4000;
// Keys this browser keeps for itself, sent to the computer from a menu instead. Super shows as ⌘.
export const SEND_KEYS: readonly { label: string; combo: string[] }[] = [
  { label: "⌘ Space", combo: ["super", "space"] },
  { label: "⌘ Tab", combo: ["super", "tab"] },
  { label: "Ctrl Alt T", combo: ["ctrl", "alt", "t"] },
  { label: "Esc", combo: ["esc"] },
];

type Send = (input: ManualStreamInput) => void;

// Text the user pastes or types here goes to the computer as typing, since it does not share this
// device's clipboard. It may be a password: the field shows bullets, and nothing stays in the page,
// since the field empties as the text leaves and when the page loses focus.
export function TypeText({
  send,
  blocked,
  onDone,
}: {
  send: Send;
  blocked?: string;
  onDone(): void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const composing = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = () => {
    const element = form.current?.elements.namedItem("text");
    return element instanceof HTMLTextAreaElement ? element : null;
  };
  useEffect(() => {
    const clear = () => {
      const element = form.current?.elements.namedItem("text");
      if (element instanceof HTMLTextAreaElement) element.value = "";
    };
    const hidden = () => {
      if (document.hidden) clear();
    };
    window.addEventListener("blur", clear);
    window.addEventListener("pagehide", clear);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", clear);
      window.removeEventListener("pagehide", clear);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const type = (value = field()?.value ?? "") => {
    const element = field();
    if (element) element.value = "";
    if (blocked || !value) return;
    if ([...value].length > TYPE_LIMIT || !value.isWellFormed() || value.includes("\0")) {
      setProblem("Type up to 4,000 characters at a time.");
      return;
    }
    setProblem(null);
    for (const input of textInputs(value)) send(input);
    onDone();
  };
  return (
    <form
      ref={form}
      className="type-text"
      aria-label="Type on the computer"
      onSubmit={(event) => {
        event.preventDefault();
        if (!composing.current) type();
      }}
    >
      <Field
        label="Text to type on the computer"
        description="Paste here: the computer doesn't share this device's clipboard."
        error={problem}
        disabledReason={blocked}
      >
        <TextArea
          name="text"
          className="type-text-field"
          maxRows={4}
          autoComplete="off"
          spellCheck={false}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          // A pasted text goes straight to the computer and never sits in the field.
          onPaste={(event) => {
            event.preventDefault();
            type(event.clipboardData.getData("text/plain"));
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              !composing.current
            ) {
              event.preventDefault();
              type();
            }
          }}
        />
      </Field>
      <Button type="submit" variant="secondary" disabledReason={blocked}>
        Type it
      </Button>
    </form>
  );
}

// Under the stage's right edge while the user has the computer (design-v2 §11 F): what a keyboard
// and mouse on this side can't do directly.
export function ControlStrip({ send, blocked }: { send: Send; blocked?: string }) {
  const keys = useRef<HTMLButtonElement>(null);
  const typing = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<"keys" | "type" | null>(null);
  const close = () => setOpen(null);
  return (
    <div className="control-strip" role="toolbar" aria-label="Computer controls">
      <Button
        ref={keys}
        variant="quiet"
        round
        icon="keyboard"
        disabledReason={blocked}
        {...triggerProps("menu", open === "keys")}
        onClick={() => setOpen("keys")}
      >
        Send keys
        <Icon name="chevron-down" size={14} className="control-strip-chevron" />
      </Button>
      <Menu
        open={open === "keys"}
        onClose={close}
        anchor={keys}
        side="top"
        align="start"
        label="Send keys"
      >
        {SEND_KEYS.map((key) => (
          <MenuItem key={key.label} onSelect={() => send({ kind: "key", combo: key.combo })}>
            {key.label}
          </MenuItem>
        ))}
      </Menu>
      <Button
        ref={typing}
        variant="quiet"
        round
        icon="type"
        disabledReason={blocked}
        {...triggerProps("dialog", open === "type")}
        onClick={() => setOpen("type")}
      >
        Type text…
      </Button>
      <Popover
        open={open === "type"}
        onClose={close}
        anchor={typing}
        side="top"
        align="end"
        label="Type on the computer"
      >
        <TypeText send={send} blocked={blocked} onDone={close} />
      </Popover>
    </div>
  );
}

// A phone's toolbar while the user has the computer (design-v2 §11 F): its keyboard, a right-click
// for the next tap, typing a pasted text, and Hand back.
export function ControlTools({
  send,
  blocked,
  typing,
  onKeyboard,
  rightClick,
  onRightClick,
  handBack,
  onHandBack,
}: {
  send: Send;
  blocked?: string;
  // The phone's keyboard is up and typing on the computer.
  typing: boolean;
  onKeyboard(on: boolean): void;
  // The next tap is a right-click.
  rightClick: boolean;
  onRightClick(on: boolean): void;
  handBack: { reason?: string; busy?: boolean };
  onHandBack(): void;
}) {
  const [sheet, setSheet] = useState(false);
  const typeButton = useRef<HTMLButtonElement>(null);
  // Pressing the button takes focus from the keyboard field before its click arrives.
  const typingAtPress = useRef<boolean | null>(null);
  return (
    <div className="control-tools" role="toolbar" aria-label="Computer controls">
      <IconButton
        size={44}
        round
        variant="filled"
        icon="keyboard"
        label="Keyboard"
        aria-pressed={typing}
        disabledReason={blocked}
        onPointerDown={() => {
          typingAtPress.current = typing;
        }}
        onClick={() => {
          const was = typingAtPress.current ?? typing;
          typingAtPress.current = null;
          onKeyboard(!was);
        }}
      />
      <IconButton
        size={44}
        round
        variant="filled"
        icon="mouse-right"
        label="Right-click the next tap"
        aria-pressed={rightClick}
        disabledReason={blocked}
        onClick={() => onRightClick(!rightClick)}
      />
      <IconButton
        ref={typeButton}
        size={44}
        round
        variant="filled"
        icon="type"
        label="Type text"
        disabledReason={blocked}
        {...triggerProps("dialog", sheet)}
        onClick={() => setSheet(true)}
      />
      <Button
        className="control-tools-hand-back"
        variant="primary"
        size="xl"
        round
        icon="hand-back"
        busy={handBack.busy}
        disabledReason={handBack.reason}
        onClick={onHandBack}
      >
        Hand back
      </Button>
      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        side="bottom"
        detents={["fit"]}
        title="Type on the computer"
        returnFocus={typeButton}
      >
        <TypeText send={send} blocked={blocked} onDone={() => setSheet(false)} />
      </Sheet>
    </div>
  );
}

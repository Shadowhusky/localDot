import { type MouseEvent, type PointerEvent, useRef, useState } from "react";
import { clampIndex, openingIndex, PAGE, type PickerOption } from "./listbox.ts";
import { type Presentation, presentationNow } from "./PickerPopup.tsx";

// Open state, the active row and the trigger's pointer handling that Select and Combobox share.
export function usePicker({
  value,
  unavailable,
  onValueChange,
}: {
  value: string;
  unavailable: boolean;
  onValueChange(value: string): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const armed = useRef(false);
  const pointer = useRef("");
  const [open, setOpen] = useState(false);
  const [presentation, setPresentation] = useState<Presentation>("popover");
  const [active, setActive] = useState(-1);

  // Opened by a pointer with nothing chosen, no row lights until the pointer reaches one.
  const show = (options: readonly PickerOption[], at?: number, byPointer = false) => {
    if (unavailable) return;
    const chosen = options.some((option) => option.value === value);
    setPresentation(presentationNow());
    setActive(at ?? (byPointer && !chosen ? -1 : openingIndex(options, value)));
    setOpen(true);
  };

  const hide = () => setOpen(false);

  const commit = (option: PickerOption) => {
    if (!open || option.disabledReason) return;
    setOpen(false);
    if (option.value !== value) onValueChange(option.value);
  };

  // Moves the active row by arrow, Home/End and page keys; reports whether the key was one of them.
  const move = (key: string, options: readonly PickerOption[]): boolean => {
    const last = options.length - 1;
    const steps: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowUp: active - 1,
      PageDown: active + PAGE,
      PageUp: active - PAGE,
      Home: 0,
      End: last,
    };
    if (!(key in steps)) return false;
    setActive(clampIndex(options, steps[key] as number));
    return true;
  };

  // A mouse opens the list on press, as a desktop pop-up menu does, so press, drag and release on a
  // row chooses it. A tap opens it on release, so a scroll that starts on the trigger never does.
  const triggerHandlers = (openList: (byPointer: boolean) => void) => ({
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      pointer.current = event.pointerType;
      if (event.button !== 0 || event.pointerType !== "mouse" || unavailable) return;
      if (open) return hide();
      event.preventDefault();
      trigger.current?.focus();
      armed.current = true;
      openList(true);
    },
    onClick(event: MouseEvent<HTMLButtonElement>) {
      const pressed = pointer.current === "mouse" && event.detail > 0;
      pointer.current = "";
      if (pressed) return;
      if (open) hide();
      else openList(event.detail > 0);
    },
  });

  return {
    trigger,
    armed,
    open,
    presentation,
    active,
    setActive,
    show,
    hide,
    commit,
    move,
    triggerHandlers,
  };
}

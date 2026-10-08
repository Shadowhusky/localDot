import { clsx } from "clsx";
import { type KeyboardEvent, useId, useMemo, useRef } from "react";
import { useFieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Listbox, optionId } from "./Listbox.tsx";
import {
  buildSections,
  flatten,
  type PickerGroup,
  type PickerItem,
  type PickerOption,
  typeahead,
} from "./listbox.ts";
import { composing, PickerPopup } from "./PickerPopup.tsx";
import { usePicker } from "./picker.ts";

// Typed letters within this long of each other make one search.
const TYPEAHEAD_MS = 500;

export interface SelectProps {
  value: string;
  onValueChange(value: string): void;
  items?: readonly PickerItem[];
  groups?: readonly PickerGroup[];
  placeholder?: string;
  // 32 px, or 36 px inside a sheet; 44 px on a touch screen either way.
  size?: "md" | "lg";
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

export function printable(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function Select({
  value,
  onValueChange,
  items,
  groups,
  placeholder = "Choose…",
  size = "md",
  className,
  "aria-label": ariaLabel,
  ...props
}: SelectProps) {
  const control = useFieldControl(props);
  const unavailable = Boolean(control.disabledReason);
  const listboxId = `${useId()}listbox`;
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const sections = useMemo(() => buildSections(items, groups), [items, groups]);
  const options = useMemo(() => flatten(sections), [sections]);
  const picker = usePicker({ value, unavailable, onValueChange });
  const { open, active } = picker;
  const selected = options.find((option) => option.value === value);
  const sheet = picker.presentation === "sheet";
  const title = ariaLabel ?? control.label ?? "";

  const typeAhead = (event: KeyboardEvent, from: number): number | undefined => {
    const now = event.timeStamp;
    const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + event.key;
    typed.current = { text, at: now };
    return typeahead(options, text, from);
  };
  const typing = (event: KeyboardEvent) =>
    event.timeStamp - typed.current.at < TYPEAHEAD_MS && typed.current.text !== "";

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (unavailable || composing(event.nativeEvent)) return;
    const { key } = event;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(key)) {
        event.preventDefault();
        picker.show(options);
      } else if (key === "Home" || key === "End") {
        event.preventDefault();
        picker.show(options, key === "Home" ? 0 : options.length - 1);
      } else if (printable(event)) {
        event.preventDefault();
        picker.show(options, typeAhead(event, options.indexOf(selected as PickerOption)));
      }
      return;
    }
    if (key === "Tab") return picker.hide();
    if (key === "Enter" || (key === " " && !typing(event)) || (key === "ArrowUp" && event.altKey)) {
      event.preventDefault();
      const option = options[active];
      if (option) picker.commit(option);
      return;
    }
    if (picker.move(key, options) || printable(event)) {
      event.preventDefault();
      if (printable(event)) {
        const found = typeAhead(event, active);
        if (found !== undefined) picker.setActive(found);
      }
    }
  };

  return (
    <>
      <button
        {...picker.triggerHandlers((byPointer) => picker.show(options, undefined, byPointer))}
        ref={picker.trigger}
        type="button"
        role="combobox"
        id={control.id}
        className={clsx("ui-field-box ui-select-trigger", className)}
        data-size={size}
        data-open={open ? "" : undefined}
        data-invalid={control.invalid ? "" : undefined}
        data-unavailable={unavailable ? "" : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : control.labelId}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-disabled={unavailable || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && !sheet && active >= 0 ? optionId(listboxId, active) : undefined
        }
        onKeyDown={onKeyDown}
      >
        <span className="ui-select-value" data-placeholder={selected || value ? undefined : ""}>
          {selected?.label ?? (value || placeholder)}
        </span>
        <Icon name="chevron-down" className="ui-select-chevron" />
      </button>
      <PickerPopup
        open={open}
        presentation={picker.presentation}
        anchor={picker.trigger}
        title={title}
        initialFocus={sheet ? list : undefined}
        armed={picker.armed}
        onDismiss={picker.hide}
      >
        <Listbox
          ref={list}
          id={listboxId}
          label={title}
          sections={sections}
          active={active}
          value={value}
          focusable={sheet}
          armed={picker.armed}
          onActive={picker.setActive}
          onCommit={picker.commit}
          onKeyDown={sheet ? onKeyDown : undefined}
        />
      </PickerPopup>
    </>
  );
}

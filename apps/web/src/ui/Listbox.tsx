// biome-ignore-all lint/a11y/useFocusableInteractive: rows are reached through aria-activedescendant on the field or list that holds focus.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the field or list that holds focus takes the keys for every row.
// biome-ignore-all lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset cannot sit in one.
import { clsx } from "clsx";
import {
  Fragment,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
} from "react";
import { Icon } from "./Icon.tsx";
import { highlight, type PickerOption, type PickerSection } from "./listbox.ts";

export function optionId(listboxId: string, index: number): string {
  return `${listboxId}-${index}`;
}

export interface ListboxProps {
  id: string;
  label: string;
  sections: readonly PickerSection[];
  active: number;
  value: string;
  terms?: readonly string[];
  // On a phone the list itself holds focus; elsewhere the trigger or search field does.
  focusable?: boolean;
  // Set while a press that began on the trigger or in the list is down, so its release can choose.
  armed: RefObject<boolean>;
  className?: string;
  onActive(index: number): void;
  onCommit(option: PickerOption): void;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
  ref?: RefObject<HTMLDivElement | null>;
}

function Label({ option, terms }: { option: PickerOption; terms?: readonly string[] }) {
  if (!terms?.length || option.custom) return option.label;
  return highlight(option.label, terms).map((span) =>
    span.match ? (
      <mark key={span.start} className="ui-match">
        {span.text}
      </mark>
    ) : (
      <Fragment key={span.start}>{span.text}</Fragment>
    ),
  );
}

export function Listbox({
  id,
  label,
  sections,
  active,
  value,
  terms,
  focusable = false,
  armed,
  className,
  onActive,
  onCommit,
  onKeyDown,
  ref,
}: ListboxProps) {
  const own = useRef<HTMLDivElement>(null);
  const list = ref ?? own;
  const hovered = useRef(false);

  // Keys move the active row into view; the pointer, which is already on it, does not.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of active row scrolls
  useLayoutEffect(() => {
    if (hovered.current) {
      hovered.current = false;
      return;
    }
    if (active < 0) return;
    const row = document.getElementById(optionId(id, active));
    if (row && list.current?.contains(row)) row.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);

  const row = (option: PickerOption): ReactNode => {
    const usable = !option.disabledReason;
    const note = option.disabledReason ?? option.description;
    return (
      <div
        key={option.custom ? "custom" : option.value}
        id={optionId(id, option.index)}
        role="option"
        className="ui-option"
        aria-selected={!option.custom && option.value === value}
        aria-disabled={usable ? undefined : true}
        data-active={option.index === active ? "" : undefined}
        data-custom={option.custom ? "" : undefined}
        data-two-line={note ? "" : undefined}
        onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
          if (event.pointerType !== "mouse" || option.index === active) return;
          hovered.current = true;
          onActive(option.index);
        }}
        onPointerDown={() => {
          armed.current = true;
        }}
        onPointerUp={() => {
          if (armed.current && usable) onCommit(option);
        }}
        onClick={() => {
          if (usable) onCommit(option);
        }}
      >
        <span className="ui-option-text">
          <span className="ui-option-label">
            <Label option={option} terms={terms} />
          </span>
          {note && <span className="ui-option-note">{note}</span>}
        </span>
        <Icon name="check" className="ui-option-check" />
      </div>
    );
  };

  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label={label}
      tabIndex={focusable ? 0 : undefined}
      aria-activedescendant={focusable && active >= 0 ? optionId(id, active) : undefined}
      className={clsx("ui-listbox", className)}
      onKeyDown={onKeyDown}
    >
      {sections.map((section) => {
        const first = section.options[0]?.index ?? 0;
        const heading = `${id}-g${first}`;
        return section.label ? (
          <div key={heading} role="group" aria-labelledby={heading} className="ui-listbox-group">
            <div id={heading} className="ui-listbox-heading" role="presentation">
              {section.label}
            </div>
            {section.options.map(row)}
          </div>
        ) : (
          <Fragment key={heading}>{section.options.map(row)}</Fragment>
        );
      })}
    </div>
  );
}

import { clsx } from "clsx";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useFieldControl } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Listbox, optionId } from "./Listbox.tsx";
import {
  buildSections,
  flatten,
  matches,
  openingIndex,
  type PickerOption,
  type PickerSection,
  searchTerms,
} from "./listbox.ts";
import { composing, PickerPopup } from "./PickerPopup.tsx";
import { usePicker } from "./picker.ts";
import { printable, type SelectProps } from "./Select.tsx";
import { TextField } from "./TextField.tsx";

export interface ComboboxProps extends SelectProps {
  searchPlaceholder?: string;
  // Offers whatever was typed as a value of its own, pinned last and described by this.
  customDescription?: string;
}

// After a search, the first row that can be chosen is active, or the typed value when nothing matches.
function searchedIndex(options: readonly PickerOption[]): number {
  const usable = options.findIndex((option) => !option.disabledReason || option.custom);
  return usable >= 0 ? usable : options.length ? 0 : -1;
}

// A Select with a search field at the top of its list, for long lists such as providers and models.
export function Combobox({
  value,
  onValueChange,
  items,
  groups,
  placeholder = "Choose…",
  searchPlaceholder = "Search",
  customDescription,
  size = "md",
  appearance = "field",
  className,
  "aria-label": ariaLabel,
  ...props
}: ComboboxProps) {
  const control = useFieldControl(props);
  const unavailable = Boolean(control.disabledReason);
  const id = useId();
  const listboxId = `${id}listbox`;
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const picker = usePicker({ value, unavailable, onValueChange });
  const { open, active } = picker;
  const sheet = picker.presentation === "sheet";
  const title = ariaLabel ?? control.label ?? "";
  const all = flatten(buildSections(items, groups));
  const selected = all.find((option) => option.value === value);

  const sectionsFor = (text: string): PickerSection[] => {
    const terms = searchTerms(text);
    const found = buildSections(items, groups, (item) => matches(item, terms));
    const typed = text.trim();
    if (customDescription && typed && !all.some((option) => option.value === typed)) {
      const index = flatten(found).length;
      const label = `Use “${typed}”`;
      found.push({
        options: [{ value: typed, label, description: customDescription, index, custom: true }],
      });
    }
    return found;
  };
  const sections = sectionsFor(query);
  const options = flatten(sections);

  const runSearch = (text: string) => {
    setQuery(text);
    const found = flatten(sectionsFor(text));
    picker.setActive(text.trim() ? searchedIndex(found) : openingIndex(found, value));
  };

  const show = (seed = "", byPointer = false) => {
    setQuery(seed);
    picker.show(all, seed ? searchedIndex(flatten(sectionsFor(seed))) : undefined, byPointer);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (unavailable || open || composing(event.nativeEvent)) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      show();
    } else if (printable(event)) {
      event.preventDefault();
      show(event.key);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (composing(event.nativeEvent)) return;
    if (event.key === "Tab") {
      picker.hide();
      picker.trigger.current?.focus();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[active];
      if (option) picker.commit(option);
      return;
    }
    // Home and End stay with the search field's caret.
    if (event.target === search.current && (event.key === "Home" || event.key === "End")) return;
    if (picker.move(event.key, options)) event.preventDefault();
  };

  return (
    <>
      <button
        {...picker.triggerHandlers((byPointer) => show("", byPointer))}
        ref={picker.trigger}
        type="button"
        role="combobox"
        id={control.id}
        className={clsx("ui-field-box ui-select-trigger", className)}
        data-size={size}
        data-appearance={appearance}
        data-open={open ? "" : undefined}
        data-invalid={control.invalid ? "" : undefined}
        data-unavailable={unavailable ? "" : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : control.labelId}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-disabled={unavailable || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="ui-select-value" data-placeholder={selected || value ? undefined : ""}>
          {selected?.label ?? (value || placeholder)}
        </span>
        <Icon name="chevrons-up-down" size={14} className="ui-select-chevron" />
      </button>
      <PickerPopup
        open={open}
        presentation={picker.presentation}
        anchor={picker.trigger}
        title={title}
        dialog
        holdHeight
        initialFocus={sheet ? list : search}
        armed={picker.armed}
        onDismiss={picker.hide}
        header={
          <div className="ui-combobox-search">
            <TextField
              ref={search}
              id={`${id}search`}
              type="search"
              role="combobox"
              size={sheet ? "md" : "sm"}
              prefix={<Icon name="search" />}
              placeholder={searchPlaceholder}
              value={query}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="done"
              aria-label={`Search: ${title}`}
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-activedescendant={active >= 0 ? optionId(listboxId, active) : undefined}
              onChange={(event) => runSearch(event.target.value)}
              onKeyDown={onListKeyDown}
            />
          </div>
        }
      >
        <Listbox
          ref={list}
          id={listboxId}
          label={title}
          sections={sections}
          active={active}
          value={value}
          terms={searchTerms(query)}
          focusable={sheet}
          armed={picker.armed}
          onActive={picker.setActive}
          onCommit={picker.commit}
          onKeyDown={sheet ? onListKeyDown : undefined}
        />
        {!options.length && <p className="ui-listbox-empty">No matches</p>}
      </PickerPopup>
    </>
  );
}

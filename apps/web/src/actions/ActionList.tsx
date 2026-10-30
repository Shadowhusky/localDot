// biome-ignore-all lint/a11y/useFocusableInteractive: rows are reached through aria-activedescendant on the field that holds focus.
// biome-ignore-all lint/a11y/useKeyWithClickEvents: the field that holds focus takes the keys for every row.
// biome-ignore-all lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset cannot sit in one.
import { clsx } from "clsx";
import { Fragment, useLayoutEffect, useRef } from "react";
import { Icon } from "../ui/Icon.tsx";
import type { IconName } from "../ui/icons.ts";
import { Kbd } from "../ui/Kbd.tsx";
import "../ui/command-menu.css";

export interface ShownRow {
  readonly key: string;
  readonly label: string;
  // Beside the label, quieter: what a command takes, or where an action belongs.
  readonly hint?: string;
  readonly note?: string;
  readonly icon?: IconName;
  readonly keys?: readonly string[];
  readonly current?: boolean;
  readonly unavailable?: boolean;
  // A heading above this row, where a group of rows starts.
  readonly section?: string;
}

export const rowId = (listId: string, index: number) => `${listId}-${index}`;

// The rows of the slash menu and the palette. Focus stays in the field that filters them; a press on
// a row never takes it.
export function ActionList({
  id,
  label,
  rows,
  active,
  compact = false,
  className,
  onActive,
  onPick,
}: {
  id: string;
  label: string;
  rows: readonly ShownRow[];
  active: number;
  // One line a row: the note follows the label.
  compact?: boolean;
  className?: string;
  onActive(index: number): void;
  onPick(index: number): void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  useLayoutEffect(() => {
    if (hovered.current) {
      hovered.current = false;
      return;
    }
    const row = active >= 0 ? document.getElementById(rowId(id, active)) : null;
    if (row && list.current?.contains(row)) row.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);
  const option = (row: ShownRow, index: number) => (
    <div
      key={row.key}
      id={rowId(id, index)}
      role="option"
      className="ui-option action-row"
      aria-selected={index === active}
      aria-disabled={row.unavailable || undefined}
      data-active={index === active ? "" : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={(event) => {
        if (event.pointerType !== "mouse" || index === active) return;
        hovered.current = true;
        onActive(index);
      }}
      onClick={() => onPick(index)}
    >
      {row.icon && <Icon name={row.icon} className="action-row-icon" />}
      <span className="action-row-text">
        <span className="action-row-label">{row.label}</span>
        {row.hint && <span className="action-row-hint">{row.hint}</span>}
        {row.note && <span className="action-row-note">{row.note}</span>}
      </span>
      {row.current && <Icon name="check" className="action-row-current" />}
      {row.keys && <Kbd keys={row.keys} className="action-row-keys" />}
    </div>
  );
  const sections: { label?: string; start: number; rows: ShownRow[] }[] = [];
  rows.forEach((row, index) => {
    const last = sections.at(-1);
    if (last && !row.section) last.rows.push(row);
    else sections.push({ label: row.section, start: index, rows: [row] });
  });
  return (
    <div
      ref={list}
      id={id}
      role="listbox"
      aria-label={label}
      data-compact={compact || undefined}
      className={clsx("ui-listbox action-list", className)}
    >
      {sections.map((section) =>
        section.label ? (
          <div
            key={section.start}
            role="group"
            aria-labelledby={`${id}-g${section.start}`}
            className="ui-listbox-group"
          >
            <div id={`${id}-g${section.start}`} className="ui-listbox-heading" role="presentation">
              {section.label}
            </div>
            {section.rows.map((row, at) => option(row, section.start + at))}
          </div>
        ) : (
          <Fragment key={section.start}>
            {section.rows.map((row, at) => option(row, section.start + at))}
          </Fragment>
        ),
      )}
    </div>
  );
}

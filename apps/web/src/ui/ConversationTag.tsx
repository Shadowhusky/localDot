import { CONVERSATION_TAGS, type ConversationTag } from "@localdot/protocol";
import type { KeyboardEvent } from "react";
import { focusWithoutScroll } from "./focus.ts";
import { useMenuItem } from "./Menu.tsx";
import "./tags.css";

export const TAG_NAMES: Record<ConversationTag, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
};

// A conversation's colour tag, drawn by its status glyph inside the glyph's own box, so it moves
// and scales with the glyph. The row's name says the tag; this only shows it.
export function TagMark({ tag }: { tag?: ConversationTag | undefined }) {
  return tag ? <span className="ui-tag-mark" data-tag={tag} aria-hidden="true" /> : null;
}

const ITEMS = "[role=menuitem], [role=menuitemradio]";

// The tags as one row of swatches in a menu, as Finder's: none first, the chosen one ringed. Left and
// right move along the row; up and down leave it for the items above and below.
export function TagSwatches({
  value,
  onSelect,
}: {
  value: ConversationTag | null;
  onSelect(tag: ConversationTag | null): void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = event.currentTarget;
    const swatches = [...row.querySelectorAll<HTMLElement>(ITEMS)];
    const at = swatches.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let to: HTMLElement | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight")
      to = swatches.at((at + (event.key === "ArrowRight" ? 1 : -1)) % swatches.length);
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const others = [
        ...(row.closest("[role=menu]")?.querySelectorAll<HTMLElement>(ITEMS) ?? []),
      ].filter((item) => !row.contains(item));
      const above = others.filter(
        (item) => item.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).length;
      to = event.key === "ArrowDown" ? (others[above] ?? others[0]) : others.at(above - 1);
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (to) focusWithoutScroll(to);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a menu groups its items with role group, not a fieldset.
    <div
      role="group"
      aria-label="Tag"
      className="ui-tag-swatches"
      data-inline-choices=""
      onKeyDown={onKeyDown}
    >
      {[null, ...CONVERSATION_TAGS].map((tag) => (
        <Swatch key={tag ?? "none"} tag={tag} checked={value === tag} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Swatch({
  tag,
  checked,
  onSelect,
}: {
  tag: ConversationTag | null;
  checked: boolean;
  onSelect(tag: ConversationTag | null): void;
}) {
  const item = useMenuItem(() => onSelect(tag));
  const name = tag ? TAG_NAMES[tag] : "No tag";
  return (
    <button
      {...item}
      role="menuitemradio"
      aria-checked={checked}
      aria-label={name}
      data-label={name}
      data-tag={tag ?? "none"}
      className="ui-tag-swatch"
    />
  );
}

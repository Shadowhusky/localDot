import { CONVERSATION_TAGS, type ConversationTag } from "@localdot/protocol";
import type { KeyboardEvent } from "react";
import { t, tr } from "../i18n/index.ts";
import { focusWithoutScroll } from "./focus.ts";
import { useMenuItem } from "./Menu.tsx";
import "./tags.css";

export const TAG_NAMES: Record<ConversationTag, string> = {
  red: tr("Red"),
  orange: tr("Orange"),
  yellow: tr("Yellow"),
  green: tr("Green"),
  blue: tr("Blue"),
  purple: tr("Purple"),
};

// A conversation's colour tag, drawn by its status glyph inside the glyph's own box, so it moves
// and scales with the glyph. The row's name says the tag; this only shows it.
export function TagMark({ tag }: { tag?: ConversationTag | undefined }) {
  return tag ? <span className="ui-tag-mark" data-tag={tag} aria-hidden="true" /> : null;
}

// A tag's colour as a dot beside its name. The name says the tag; this only shows it.
export function TagDot({ tag }: { tag: ConversationTag }) {
  return <span className="ui-tag-dot" data-tag={tag} aria-hidden="true" />;
}

const ITEMS = "[role=menuitem], [role=menuitemradio]";

// The tags as one row of swatches in a menu, as Finder's: none first, the chosen one ringed. Left and
// right move along the row; up and down leave it for the items above and below.
// In a menu, or on its own (`standalone`), as in a conversation's details: a set of radios there.
export function TagSwatches({
  value,
  onSelect,
  standalone = false,
}: {
  value: ConversationTag | null;
  onSelect(tag: ConversationTag | null): void;
  standalone?: boolean;
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
  const tags = [null, ...CONVERSATION_TAGS];
  if (standalone)
    return (
      <div role="radiogroup" aria-label={t`Tag`} className="ui-tag-swatches">
        {tags.map((tag) => (
          // biome-ignore lint/a11y/useSemanticElements: a swatch is a coloured button, not a radio input's circle.
          <button
            key={tag ?? "none"}
            type="button"
            role="radio"
            aria-checked={value === tag}
            aria-label={tag ? TAG_NAMES[tag] : t`No tag`}
            data-tag={tag ?? "none"}
            className="ui-tag-swatch"
            onClick={() => onSelect(tag)}
          />
        ))}
      </div>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a menu groups its items with role group, not a fieldset.
    <div
      role="group"
      aria-label={t`Tag`}
      className="ui-tag-swatches"
      data-inline-choices=""
      onKeyDown={onKeyDown}
    >
      {tags.map((tag) => (
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
  const name = tag ? TAG_NAMES[tag] : t`No tag`;
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

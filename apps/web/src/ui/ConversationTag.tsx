import {
  CONVERSATION_TAGS,
  type ConversationEntry,
  type ConversationTag,
  type TagId,
  type TagOnConversation,
} from "@localdot/protocol";
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

// A tag's name: the user's, or its colour's.
export const tagName = (tag: Pick<TagOnConversation, "color" | "name">) =>
  tag.name ?? TAG_NAMES[tag.color];

// "blue tag", "Travel tag": what a screen reader says of each.
export const tagWords = (tag: Pick<TagOnConversation, "color" | "name">) =>
  tag.name ? t`${tag.name} tag` : t`${TAG_NAMES[tag.color].toLowerCase()} tag`;

// The colour a conversation's mark shows: its first colour's, else its first tag's.
export const markOf = (entry: ConversationEntry) =>
  (entry.tags?.find((tag) => !tag.name) ?? entry.tags?.[0])?.color;

// The user's own tags a row names, a colour before each; the colours alone are its mark.
export function TagNames({ tags }: { tags: readonly TagOnConversation[] | undefined }) {
  const named = tags?.filter((tag) => tag.name) ?? [];
  if (!named.length) return null;
  return (
    <span className="ui-tag-names">
      {named.map((tag) => (
        <span key={tag.id} className="ui-tag-name">
          <TagDot tag={tag.color} />
          {tag.name}
        </span>
      ))}
    </span>
  );
}

// The one colour a tag of the user's takes.
export function ColourChoice({
  value,
  onSelect,
}: {
  value: ConversationTag;
  onSelect(colour: ConversationTag): void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of colour choices, not a form's fieldset.
    <div role="radiogroup" aria-label={t`Colour`} className="ui-tag-swatches">
      {CONVERSATION_TAGS.map((colour) => (
        // biome-ignore lint/a11y/useSemanticElements: a swatch is a coloured button, not a radio input's circle.
        <button
          key={colour}
          type="button"
          role="radio"
          aria-checked={value === colour}
          aria-label={TAG_NAMES[colour]}
          data-tag={colour}
          className="ui-tag-swatch"
          onClick={() => onSelect(colour)}
        />
      ))}
    </div>
  );
}

// A conversation's colour tag, drawn by its status glyph inside the glyph's own box, so it moves
// and scales with the glyph. The row's name says the tag; this only shows it.
export function TagMark({ tag }: { tag?: ConversationTag | undefined }) {
  return tag ? <span className="ui-tag-mark" data-tag={tag} aria-hidden="true" /> : null;
}

// A tag's colour as a dot beside its name. The name says the tag; this only shows it.
export function TagDot({ tag }: { tag: ConversationTag }) {
  return <span className="ui-tag-dot" data-tag={tag} aria-hidden="true" />;
}

const ITEMS = "[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]";

// The colours as one row of swatches in a menu, as Finder's: none first, those given ringed. A colour
// is given or taken off; none takes every tag off. Left and right move along the row; up and down
// leave it for the items above and below. In a menu, or on its own (`standalone`), as in a
// conversation's details: a set of checkboxes there.
export function TagSwatches({
  chosen,
  onSelect,
  standalone = false,
}: {
  chosen: readonly TagId[];
  onSelect(tag: ConversationTag | null): void;
  standalone?: boolean;
}) {
  const given = (tag: ConversationTag | null) => (tag ? chosen.includes(tag) : !chosen.length);
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
      // biome-ignore lint/a11y/useSemanticElements: a row of toggles, not a form's fieldset.
      <div role="group" aria-label={t`Tag`} className="ui-tag-swatches">
        {tags.map((tag) => (
          // biome-ignore lint/a11y/useSemanticElements: a swatch is a coloured button, not a checkbox's box.
          <button
            key={tag ?? "none"}
            type="button"
            role="checkbox"
            aria-checked={given(tag)}
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
        <Swatch key={tag ?? "none"} tag={tag} checked={given(tag)} onSelect={onSelect} />
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
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-label={name}
      data-label={name}
      data-tag={tag ?? "none"}
      className="ui-tag-swatch"
    />
  );
}

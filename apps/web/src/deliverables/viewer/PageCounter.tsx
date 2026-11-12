import { type CSSProperties, useState } from "react";
import { t } from "../../i18n/index.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { VisuallyHidden } from "../../ui/VisuallyHidden.tsx";
import { typedPage } from "./paging.ts";

// Stands for the field in the sentence the counter's words are cut from.
const FIELD = "\u0000";

// "Page 12 of 300" between the previous and next buttons. The number is a field: type another and
// press Return to go there; Esc or leaving it puts back the page on show.
export function PageCounter({
  page,
  count,
  noun,
  onGo,
}: {
  page: number;
  count: number;
  noun: "Page" | "Slide";
  onGo(page: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const slides = noun === "Slide";
  // The words either side of the field come from the one sentence a screen reader hears, so each
  // language keeps its own order.
  const [before = "", after = ""] = (
    slides ? t`Slide ${FIELD} of ${count}` : t`Page ${FIELD} of ${count}`
  ).split(FIELD);
  const go = () => {
    const next = draft === null ? undefined : typedPage(draft, count);
    setDraft(null);
    if (next !== undefined && next !== page) onGo(next);
  };
  return (
    <div className="viewer-pager">
      <IconButton
        icon="chevron-left"
        size={28}
        label={slides ? t`Previous slide` : t`Previous page`}
        disabledReason={
          page <= 1 ? (slides ? t`This is the first slide` : t`This is the first page`) : undefined
        }
        onClick={() => onGo(page - 1)}
      />
      <div className="viewer-page-count num">
        <span>{before.trim()}</span>
        <span
          className="viewer-page-field"
          style={{ "--_digits": String(count).length } as CSSProperties}
        >
          <TextField
            size="sm"
            inputMode="numeric"
            enterKeyHint="go"
            autoComplete="off"
            aria-label={slides ? t`Slide number, of ${count}` : t`Page number, of ${count}`}
            value={draft ?? String(page)}
            onFocus={(event) => {
              setDraft(String(page));
              event.currentTarget.select();
            }}
            onChange={(event) => setDraft(event.currentTarget.value.replace(/\D/g, "").slice(0, 7))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                go();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDraft(null);
                event.currentTarget.blur();
              }
            }}
            onBlur={() => setDraft(null)}
          />
        </span>
        <span>{after.trim()}</span>
      </div>
      <VisuallyHidden aria-live="polite">
        {slides ? t`Slide ${page} of ${count}` : t`Page ${page} of ${count}`}
      </VisuallyHidden>
      <IconButton
        icon="chevron-right"
        size={28}
        label={slides ? t`Next slide` : t`Next page`}
        disabledReason={
          page >= count
            ? slides
              ? t`This is the last slide`
              : t`This is the last page`
            : undefined
        }
        onClick={() => onGo(page + 1)}
      />
    </div>
  );
}

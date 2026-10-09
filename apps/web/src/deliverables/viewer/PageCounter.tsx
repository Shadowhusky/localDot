import { type CSSProperties, useState } from "react";
import { IconButton } from "../../ui/IconButton.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { VisuallyHidden } from "../../ui/VisuallyHidden.tsx";
import { typedPage } from "./paging.ts";

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
  const lower = noun.toLowerCase();
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
        label={`Previous ${lower}`}
        disabledReason={page <= 1 ? `This is the first ${lower}` : undefined}
        onClick={() => onGo(page - 1)}
      />
      <div className="viewer-page-count num">
        <span>{noun}</span>
        <span
          className="viewer-page-field"
          style={{ "--_digits": String(count).length } as CSSProperties}
        >
          <TextField
            size="sm"
            inputMode="numeric"
            enterKeyHint="go"
            autoComplete="off"
            aria-label={`${noun} number, of ${count}`}
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
        <span>of {count}</span>
      </div>
      <VisuallyHidden aria-live="polite">
        {noun} {page} of {count}
      </VisuallyHidden>
      <IconButton
        icon="chevron-right"
        size={28}
        label={`Next ${lower}`}
        disabledReason={page >= count ? `This is the last ${lower}` : undefined}
        onClick={() => onGo(page + 1)}
      />
    </div>
  );
}

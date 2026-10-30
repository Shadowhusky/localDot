import type { RefObject } from "react";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { TextField } from "../ui/TextField.tsx";
import { useTooltip } from "../ui/Tooltip.tsx";

export interface RailSearchProps {
  expanded: boolean;
  query: string;
  onQuery(query: string): void;
  // The collapsed rail's search mark: names and snippets need the room, so it expands the rail.
  onOpen(): void;
  // Focus the field as it shows, after onOpen.
  focusOnShow: boolean;
  onShown(): void;
  // Down from the field moves into the results; Return takes up the first.
  onDown(): void;
  onEnter(): void;
  inputRef: RefObject<HTMLInputElement | null>;
  resultsId: string;
}

// The search at the top of the conversations rail. Escape empties it first.
export function RailSearch({
  expanded,
  query,
  onQuery,
  onOpen,
  focusOnShow,
  onShown,
  onDown,
  onEnter,
  inputRef,
  resultsId,
}: RailSearchProps) {
  const { triggerProps: tip, tooltip } = useTooltip({
    content: expanded ? undefined : "Search conversations",
  });
  if (!expanded)
    return (
      <div className="sessions-search">
        <Button
          {...tip.handlers}
          variant="quiet"
          className="sessions-row"
          aria-label="Search conversations"
          onClick={onOpen}
        >
          <Icon name="search" />
          <span className="sessions-title">Search</span>
        </Button>
        {tooltip}
      </div>
    );
  return (
    <div className="sessions-search">
      <TextField
        ref={inputRef}
        size="sm"
        filled
        className="sessions-search-field"
        prefix={<Icon name="search" />}
        suffix={
          query ? (
            <IconButton
              icon="x"
              size={24}
              label="Clear search"
              onClick={() => {
                onQuery("");
                inputRef.current?.focus();
              }}
            />
          ) : undefined
        }
        aria-label="Search conversations"
        aria-controls={resultsId}
        placeholder="Search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        autoFocus={focusOnShow}
        value={query}
        onFocus={onShown}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && query) {
            event.preventDefault();
            event.stopPropagation();
            onQuery("");
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            onDown();
          } else if (event.key === "Enter" && query.trim()) {
            event.preventDefault();
            onEnter();
          }
        }}
      />
    </div>
  );
}

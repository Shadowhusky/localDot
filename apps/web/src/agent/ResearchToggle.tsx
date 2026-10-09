import { Chip } from "../ui/Chip.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";

const WHAT = "Research: dot reads many sources and writes a report with citations";
const SUGGESTED = "dot suggests research for this question";

export interface ResearchToggleProps {
  on: boolean;
  // The message reads like a question that needs many sources.
  suggested: boolean;
  // Unavailable while set, with this as the reason.
  disabledReason?: string;
  onToggle(): void;
}

// Research mode for the next task, in the composer's row: a chip pressed while it is on. dot's
// suggestion brightens its edge and lights a neutral point at its corner; it never moves anything.
export function ResearchToggle({ on, suggested, disabledReason, onToggle }: ResearchToggleProps) {
  const hint = suggested && !on;
  return (
    <Chip
      variant="outline"
      icon="library"
      className="composer-research"
      hint={hint ? SUGGESTED : WHAT}
      disabledReason={disabledReason}
      aria-pressed={on}
      data-suggested={hint || undefined}
      onClick={onToggle}
    >
      Research
      <span className="composer-research-hint" aria-hidden="true" />
    </Chip>
  );
}

// A phone's field has room for its words and Send only: research shows over it, as a chip that
// says it is on with a way to stop, or as dot's suggestion to turn it on.
export function ResearchLine({ on, onToggle }: { on: boolean; onToggle(): void }) {
  return (
    <div className="file-chips-block">
      {on ? (
        <p className="file-chips">
          <span className="file-chip" data-research="">
            <Icon name="library" size={12} className="file-chip-icon" />
            <span>Research</span>
            <span className="file-chip-meta">a cited report</span>
            <IconButton
              className="file-chip-remove"
              icon="x"
              size={24}
              label="Don't research"
              onClick={onToggle}
            />
          </span>
        </p>
      ) : (
        <Chip variant="outline" icon="library" hint={SUGGESTED} onClick={onToggle}>
          Research this question
        </Chip>
      )}
    </div>
  );
}

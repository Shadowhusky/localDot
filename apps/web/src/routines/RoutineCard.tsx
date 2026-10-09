import type { RoutineProposal } from "../agent/model.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { useRoutinesControl } from "./context.ts";
import { AWAY, NOTIFY, nextRunText } from "./routine-copy.ts";

const money = (usd: number) => `$${usd.toFixed(2)}`;

// A routine dot drafted in the chat. Nothing runs until Save routine; the card then says when it
// runs next, in the place its buttons held.
export function RoutineCard({ proposal }: { proposal: RoutineProposal }) {
  const control = useRoutinesControl();
  const view = control?.view;
  const routine = view?.reply?.routines.find((row) => row.id === proposal.routineId);
  const shown = routine ?? proposal;
  const known = view?.reply !== undefined;
  const open = routine?.state === "proposed" || !known;
  return (
    <article className="routine-card" aria-label={`Routine: ${shown.name}`}>
      <div className="routine-card-head">
        <span className="routine-card-eyebrow">
          <Icon name="repeat" size={14} />
          Routine
        </span>
        <h3 className="routine-card-name">{shown.name}</h3>
        <span className="routine-card-when">{shown.summary}</span>
      </div>
      <p className="routine-card-what">{shown.instruction}</p>
      <dl className="routine-card-facts">
        <dt>While you're away</dt>
        <dd>{AWAY[shown.profile].label}</dd>
        <dt>Tell me</dt>
        <dd>{NOTIFY[shown.notify]}</dd>
        <dt>Spending limit</dt>
        <dd>{shown.budgetUSD === null ? "None" : money(shown.budgetUSD)}</dd>
      </dl>
      {open ? (
        <div className="routine-card-actions">
          <Button
            variant="primary"
            icon="check"
            busy={view?.busy}
            disabledReason={routine ? undefined : "Loading…"}
            onClick={() =>
              routine &&
              void view?.act((api) => api.confirm(routine.id, { revision: routine.revision }))
            }
          >
            Save routine
          </Button>
          <Button
            disabledReason={routine ? undefined : "Loading…"}
            onClick={(event) =>
              routine && control?.open({ mode: "confirm", id: routine.id }, event.currentTarget)
            }
          >
            Edit
          </Button>
          <Button
            variant="quiet"
            disabledReason={routine ? undefined : "Loading…"}
            onClick={() =>
              routine && void view?.act((api) => api.remove(routine.id, routine.revision))
            }
          >
            Discard
          </Button>
        </div>
      ) : routine ? (
        <p className="routine-card-outcome" role="status">
          <StatusGlyph state="done" label="Saved" />
          Saved · {nextRunText(routine, Date.now())}
        </p>
      ) : (
        <p className="routine-card-outcome" role="status">
          <StatusGlyph state="skipped" label="Discarded" />
          Discarded
        </p>
      )}
    </article>
  );
}

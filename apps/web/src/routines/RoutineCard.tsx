import type { Routine } from "@localdot/protocol";
import type { RoutineProposal } from "../agent/model.ts";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { useRoutinesControl } from "./context.ts";
import { AWAY, budgetText, NOTIFY, nextRunText } from "./routine-copy.ts";

// Save, change or throw away a routine dot drafted.
function RoutineChoices({ routine }: { routine: Routine }) {
  const control = useRoutinesControl();
  const view = control?.view;
  return (
    <div className="routine-card-actions">
      <Button
        variant="primary"
        icon="check"
        busy={view?.busy}
        onClick={() =>
          void view?.act((api) => api.confirm(routine.id, { revision: routine.revision }))
        }
      >
        {t`Save routine`}
      </Button>
      <Button
        onClick={(event) => control?.open({ mode: "confirm", id: routine.id }, event.currentTarget)}
      >
        {t`Edit`}
      </Button>
      <Button
        variant="quiet"
        onClick={() => void view?.act((api) => api.remove(routine.id, routine.revision))}
      >
        {t`Discard`}
      </Button>
    </div>
  );
}

// The routines of this conversation that wait for an answer. dot goes on talking after it drafts
// one, so the choice stays above the composer, oldest first, until it is made.
export function PendingRoutines({ sessions }: { sessions: readonly string[] }) {
  const reply = useRoutinesControl()?.view.reply;
  const waiting = (reply?.routines ?? []).filter(
    (routine) =>
      routine.state === "proposed" &&
      routine.createdFromSession !== null &&
      sessions.includes(routine.createdFromSession),
  );
  const routine = waiting[0];
  if (!routine) return null;
  return (
    <section className="routine-pending" aria-label={t`Routine waiting for you: ${routine.name}`}>
      <div className="routine-pending-text">
        <span className="routine-card-eyebrow">
          <Icon name="repeat" size={14} />
          {waiting.length > 1
            ? t`Save this routine? 1 of ${waiting.length}`
            : t`Save this routine?`}
        </span>
        <strong className="routine-pending-name">{routine.name}</strong>
        <span className="routine-card-when">{routine.summary}</span>
      </div>
      <RoutineChoices routine={routine} />
    </section>
  );
}

// A routine dot drafted, where it drafted it. Nothing runs until Save routine, which waits above the
// composer; the card then says when it runs next, in the place its status held. One line in every
// state, so the thread never shrinks under the end it follows as the choice arrives.
export function RoutineCard({ proposal }: { proposal: RoutineProposal }) {
  const view = useRoutinesControl()?.view;
  const routine = view?.reply?.routines.find((row) => row.id === proposal.routineId);
  const shown = routine ?? proposal;
  const known = view?.reply !== undefined;
  return (
    <article className="routine-card" aria-label={t`Routine: ${shown.name}`}>
      <div className="routine-card-head">
        <span className="routine-card-eyebrow">
          <Icon name="repeat" size={14} />
          {t`Routine`}
        </span>
        <h3 className="routine-card-name">{shown.name}</h3>
        <span className="routine-card-when">{shown.summary}</span>
      </div>
      <p className="routine-card-what">{shown.instruction}</p>
      <dl className="routine-card-facts">
        <dt>{t`While you're away`}</dt>
        <dd>{AWAY[shown.profile].label}</dd>
        <dt>{t`Tell me`}</dt>
        <dd>{NOTIFY[shown.notify]}</dd>
        <dt>{t`Spending limit`}</dt>
        <dd>{budgetText(shown.budgetUSD)}</dd>
      </dl>
      {known && !routine ? (
        <p className="routine-card-outcome" role="status">
          <StatusGlyph state="skipped" label={t`Discarded`} />
          {t`Discarded`}
        </p>
      ) : routine && routine.state !== "proposed" ? (
        <p className="routine-card-outcome" role="status">
          <StatusGlyph state="done" label={t`Saved`} />
          {t`Saved · ${nextRunText(routine, Date.now())}`}
        </p>
      ) : (
        <p className="routine-card-outcome" role="status">
          <StatusGlyph state="ask" label={t`Waiting`} />
          {t`Waiting for your answer`}
        </p>
      )}
    </article>
  );
}

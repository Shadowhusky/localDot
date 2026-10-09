import type { Routine, RoutineDraft, RoutineRun } from "@localdot/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Banner } from "../ui/Banner.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Group, GroupHead, GroupRow } from "../ui/Group.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Switch } from "../ui/Switch.tsx";
import { DeleteRoutine } from "./DeleteRoutine.tsx";
import { RoutineForm } from "./RoutineForm.tsx";
import { RunHistory } from "./RunHistory.tsx";
import { AWAY, MISSED, NOTIFY, nextRunText, waitText } from "./routine-copy.ts";
import {
  draftFromForm,
  type FormErrors,
  formFromRoutine,
  type RoutineFormState,
} from "./routine-form.ts";
import type { RoutinesView } from "./useRoutines.ts";

export type RoutineTarget =
  | { mode: "detail"; id: string }
  | { mode: "new" }
  // A routine dot proposed, edited before it is saved.
  | { mode: "confirm"; id: string };

export interface RoutineSheetProps {
  routines: RoutinesView;
  target: RoutineTarget | null;
  onClose(): void;
  onWatch?(sessionId: string): void;
  returnFocus?: RefObject<HTMLElement | null>;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

// One routine: what it does and how its runs went, and the form to change it; or a new one.
export function RoutineSheet({
  routines,
  target,
  onClose,
  onWatch,
  returnFocus,
}: RoutineSheetProps) {
  const zone = routines.reply?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const id = target && target.mode !== "new" ? target.id : null;
  const routine = id ? routines.reply?.routines.find((row) => row.id === id) : undefined;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<RoutineFormState | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);

  // Each opening starts afresh: the form from the routine as saved, or the defaults.
  const [opened, setOpened] = useState<string | null>(null);
  const key = target ? `${target.mode}:${id ?? ""}` : null;
  if (opened !== key) {
    setOpened(key);
    const formMode = target?.mode === "new" || target?.mode === "confirm";
    if (editing !== formMode) setEditing(formMode);
    setErrors({});
    setForm(
      target?.mode === "new"
        ? formFromRoutine(null, zone)
        : routine
          ? formFromRoutine(routine, zone)
          : null,
    );
  }
  if (form === null && editing && routine) setForm(formFromRoutine(routine, zone));

  const saved = routine ? formFromRoutine(routine, zone) : formFromRoutine(null, zone);
  const dirty = editing && !!form && JSON.stringify(form) !== JSON.stringify(saved);

  const save = async () => {
    if (!form) return;
    const result = draftFromForm(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    const draft: RoutineDraft = result.draft;
    const ok = await routines.act((api) => {
      if (target?.mode === "new") return api.create(draft);
      if (!routine) throw new Error("gone");
      if (target?.mode === "confirm")
        return api.confirm(routine.id, { revision: routine.revision, edits: draft });
      return api.update(routine.id, {
        ...draft,
        revision: routine.revision,
        until: draft.until ?? null,
      });
    });
    setSaving(false);
    if (!ok) return;
    if (target?.mode === "detail") setEditing(false);
    else onClose();
  };

  const title =
    target?.mode === "new"
      ? "New routine"
      : target?.mode === "confirm"
        ? "Save this routine"
        : editing
          ? "Edit routine"
          : (routine?.name ?? "Routine");
  const footer = editing ? (
    <div className="routine-sheet-footer">
      {routines.problem && (
        <p className="routine-sheet-problem" role="alert">
          {routines.problem}
        </p>
      )}
      <Button
        variant="quiet"
        onClick={() => (target?.mode === "detail" ? setEditing(false) : onClose())}
      >
        Cancel
      </Button>
      <Button variant="primary" busy={saving} onClick={() => void save()}>
        Save routine
      </Button>
    </div>
  ) : routine ? (
    <div className="routine-sheet-footer">
      <Button
        ref={deleteButton}
        variant="destructive"
        icon="trash"
        onClick={() => setDeleting(true)}
      >
        Delete…
      </Button>
      <span className="routine-sheet-gap" />
      <Button onClick={() => setEditing(true)}>Edit</Button>
      <Button
        variant="primary"
        icon="play"
        disabledReason={routine.state === "proposed" ? "Save it first" : undefined}
        onClick={() => void routines.act((api) => api.runNow(routine.id))}
      >
        Run now
      </Button>
    </div>
  ) : undefined;

  return (
    <>
      <Sheet
        open={target !== null}
        onClose={onClose}
        title={title}
        description={!editing && routine ? routine.summary : undefined}
        page={editing ? "form" : "detail"}
        back={
          editing && target?.mode === "detail"
            ? { label: routine?.name ?? "Routine", onBack: () => setEditing(false) }
            : undefined
        }
        dirty={dirty}
        modal
        returnFocus={returnFocus}
        closeLabel="Close routine"
        detents={["large"]}
        className="routine-sheet"
        footer={footer}
      >
        {editing && form ? (
          <RoutineForm value={form} errors={errors} zone={zone} onChange={setForm} />
        ) : routine ? (
          <RoutineDetail routine={routine} routines={routines} onWatch={onWatch} />
        ) : (
          <EmptyState title="This routine was deleted" icon="repeat" />
        )}
      </Sheet>
      <DeleteRoutine
        routine={deleting && routine ? routine : null}
        anchor={deleteButton}
        busy={routines.busy}
        onClose={() => setDeleting(false)}
        onDelete={(gone) =>
          void routines
            .act((api) => api.remove(gone.id, gone.revision))
            .then((ok) => {
              setDeleting(false);
              if (ok) onClose();
            })
        }
      />
    </>
  );
}

function RoutineDetail({
  routine,
  routines,
  onWatch,
}: {
  routine: Routine;
  routines: RoutinesView;
  onWatch?(sessionId: string): void;
}) {
  const [runs, setRuns] = useState<readonly RoutineRun[] | undefined>(undefined);
  const lastRun = routine.lastRun;
  const api = routines.api;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new run or a new state reads again
  useEffect(() => {
    let current = true;
    api
      .runs(routine.id)
      .then((next) => {
        if (current) setRuns(next);
      })
      .catch(() => {
        if (current) setRuns([]);
      });
    return () => {
      current = false;
    };
  }, [api, routine.id, routine.revision, lastRun?.id, lastRun?.outcome]);

  const on = routine.state === "active";
  const switchable = routine.state === "active" || routine.state === "paused";
  return (
    <div className="routine-detail">
      {routine.keepAsked && (
        <Banner
          tone="attention"
          title={`Keep running ${routine.name}?`}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void routines.act((each) => each.seen(routine.id))}
              >
                Keep running
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void routines.act((each) =>
                    each.update(routine.id, { revision: routine.revision, state: "paused" }),
                  )
                }
              >
                Pause
              </Button>
            </>
          }
        >
          Nobody has opened what it found for two weeks.
        </Banner>
      )}
      <p className="routine-instruction">{routine.instruction}</p>
      <Group>
        <Switch
          className="ui-group-row"
          label="Runs on schedule"
          description={
            routine.pausedReason === "stop_all"
              ? "Paused by Stop everything"
              : routine.pausedReason === "absence"
                ? "Paused: nobody answered Keep running"
                : nextRunText(routine, Date.now())
          }
          checked={on}
          disabledReason={
            switchable
              ? undefined
              : routine.state === "proposed"
                ? "Save it first"
                : "Finished. Change when it runs to use it again."
          }
          onCheckedChange={(checked) =>
            void routines.act((each) =>
              each.update(routine.id, {
                revision: routine.revision,
                state: checked ? "active" : "paused",
              }),
            )
          }
        />
        <GroupRow label="While you're away" trailing={AWAY[routine.profile].label} />
        <GroupRow label="Tell me" trailing={NOTIFY[routine.notify]} />
        <GroupRow label="If a run is missed" trailing={MISSED[routine.missedPolicy]} />
        <GroupRow label="Wait for my answer" trailing={waitText(routine.approvalWindowMinutes)} />
        <GroupRow
          label="Spending limit per run"
          trailing={routine.budgetUSD === null ? "None" : money(routine.budgetUSD)}
        />
      </Group>
      <div>
        <GroupHead title="Recent runs" />
        <RunHistory runs={runs} tz={routine.tz} onOpen={onWatch} />
      </div>
    </div>
  );
}

import type { Routine } from "@localdot/protocol";
import { memo, useRef, useState } from "react";
import { count } from "../copy/format.ts";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Group } from "../ui/Group.tsx";
import { ListRow } from "../ui/ListRow.tsx";
import { MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { ScrollArea } from "../ui/ScrollArea.tsx";
import { Skeleton } from "../ui/Skeleton.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { Switch } from "../ui/Switch.tsx";
import { DeleteRoutine } from "./DeleteRoutine.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { OUTCOME_WORDS, outcomeGlyph, rowState } from "./routine-copy.ts";
import type { RoutinesView } from "./useRoutines.ts";
import "./routines.css";

export interface RoutinesPanelProps {
  routines: RoutinesView;
  onOpen(routine: Routine, trigger?: HTMLElement): void;
  onNew(trigger?: HTMLElement): void;
  // A phone's row: its actions always show and its targets are 44 px.
  compact?: boolean;
}

const SKELETON_ROWS = 3;

// The routines dot runs on its own: each one's schedule, when it runs next and how it last went.
export const RoutinesPanel = memo(function RoutinesPanel({
  routines,
  onOpen,
  onNew,
  compact = false,
}: RoutinesPanelProps) {
  // A routine dot proposed waits in the chat until it is saved or discarded there.
  const list = (routines.reply?.routines ?? []).filter((routine) => routine.state !== "proposed");
  const now = Date.now();
  const active = list.filter((routine) => routine.state === "active").length;
  const login = routines.reply?.startAtLogin;
  return (
    <div className="routines-panel">
      <ScrollArea className="routines-scroll" fade="bottom">
        <div className="routines-content">
          {routines.reply === undefined ? (
            routines.failed ? (
              <EmptyState
                title="Routines can't be read right now"
                icon="circle-alert"
                actions={
                  <Button size="sm" onClick={routines.reload}>
                    Try again
                  </Button>
                }
              />
            ) : (
              <div className="routines-list" aria-busy="true">
                {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                  <Skeleton
                    // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                    key={index}
                    loading
                    shape="block"
                    width="100%"
                    height="60px"
                  />
                ))}
              </div>
            )
          ) : list.length === 0 ? (
            <EmptyState
              title="Nothing runs on its own yet"
              icon="repeat"
              actions={
                <Button icon="plus" onClick={(event) => onNew(event.currentTarget)}>
                  New routine
                </Button>
              }
            >
              Tell dot something like "Every weekday at 9, check my inbox and tell me what needs a
              reply". It shows you the routine to save. Or set one up here.
            </EmptyState>
          ) : (
            <>
              <div className="routines-head">
                <p className="routines-count">
                  {count(list.length, "routine", "routines")}
                  {active < list.length && ` · ${active} on`}
                </p>
                <Button size="sm" icon="plus" onClick={(event) => onNew(event.currentTarget)}>
                  New routine
                </Button>
              </div>
              {login !== undefined && login !== "unavailable" && (
                <Group>
                  <Switch
                    className="ui-group-row"
                    label="Start localDot at login"
                    description="Routines run only while it's running"
                    checked={login === "on"}
                    disabledReason={routines.busy ? "Saving…" : undefined}
                    onCheckedChange={(on) => void routines.act((api) => api.setStartAtLogin(on))}
                  />
                </Group>
              )}
              {routines.problem && (
                <p className="routines-problem" role="alert">
                  {routines.problem}
                </p>
              )}
              <div className="routines-list">
                {list.map((routine) => (
                  <RoutineRow
                    key={routine.id}
                    routine={routine}
                    now={now}
                    compact={compact}
                    routines={routines}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

function RoutineRow({
  routine,
  now,
  compact,
  routines,
  onOpen,
}: {
  routine: Routine;
  now: number;
  compact: boolean;
  routines: RoutinesView;
  onOpen(routine: Routine, trigger?: HTMLElement): void;
}) {
  const last = routine.lastRun;
  const on = routine.state === "active";
  const runnable = routine.state !== "proposed";
  const more = useRef<HTMLButtonElement>(null);
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <ListRow
        className="routine-row"
        compact
        title={routine.name}
        onSelect={() => onOpen(routine)}
        meta={
          <>
            {routine.keepAsked ? (
              <StatusGlyph state="ask" />
            ) : last ? (
              <StatusGlyph state={outcomeGlyph(last.outcome)} label={OUTCOME_WORDS[last.outcome]} />
            ) : (
              <StatusGlyph state="todo" label="Not run yet" />
            )}
            <span>
              {routine.keepAsked
                ? "Keep running it? Open to answer"
                : `${routine.summary.split(" · ")[0]} · ${rowState(routine, now)}`}
            </span>
          </>
        }
        actions={
          <RowMenu ref={more} label={`More for ${routine.name}`} size={compact ? 44 : 28}>
            <MenuItem
              icon="play"
              disabledReason={runnable ? undefined : "Save it first"}
              onSelect={() => void routines.act((api) => api.runNow(routine.id))}
            >
              Run now
            </MenuItem>
            <MenuItem icon="file-text" onSelect={() => onOpen(routine)}>
              Details
            </MenuItem>
            {(routine.state === "active" || routine.state === "paused") && (
              <MenuItem
                icon={on ? "pause" : "play"}
                onSelect={() =>
                  void routines.act((api) =>
                    api.update(routine.id, {
                      revision: routine.revision,
                      state: on ? "paused" : "active",
                    }),
                  )
                }
              >
                {on ? "Pause" : "Turn back on"}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon="trash" onSelect={() => setDeleting(true)}>
              Delete…
            </MenuItem>
          </RowMenu>
        }
      />
      <DeleteRoutine
        routine={deleting ? routine : null}
        anchor={more}
        busy={routines.busy}
        onClose={() => setDeleting(false)}
        onDelete={(gone) =>
          void routines
            .act((api) => api.remove(gone.id, gone.revision))
            .then(() => setDeleting(false))
        }
      />
    </>
  );
}

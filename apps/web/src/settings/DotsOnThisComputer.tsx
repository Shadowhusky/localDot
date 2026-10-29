import type { DotSummary } from "@localdot/protocol";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { StopDotDialog } from "../shell/StopDotDialog.tsx";
import type { LocalDots } from "../shell/useLocalDots.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { AddDotSheet } from "./AddDotSheet.tsx";
import { DOT_STATE_WORD } from "./dot-copy.ts";
import { dotProblem, removeDot } from "./dots-api.ts";

// Every dot on this computer: its own address, keys and computer, run by one installation. Others
// start and stop from here; this one can be removed unless it is the installation's first.
export function DotsOnThisComputer({
  api,
  dots,
  navigate = (url) => window.location.assign(url),
}: {
  api: ApiClient;
  dots: LocalDots;
  navigate?(url: string): void;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [stopping, setStopping] = useState<DotSummary | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const addRow = useRef<HTMLElement | null>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const { refresh } = dots;
  useEffect(() => refresh(), [refresh]);
  const list = dots.dots;
  const self = list?.find((dot) => dot.self);
  const report = (pending: Promise<string | null>) => void pending.then((text) => setProblem(text));
  return (
    <div>
      <GroupHead title="Dots on this computer" />
      <Group>
        {list === null ? (
          <GroupRow label="Looking for dots on this computer…" />
        ) : (
          list.map((dot) => (
            <GroupRow
              key={dot.id}
              leading={<IconTile icon="smile" />}
              label={dot.name}
              detail={dot.self ? "This dot" : DOT_STATE_WORD[dot.state]}
              trailing={
                !dot.self &&
                dots.manage &&
                (dot.state === "running" ? (
                  <Button
                    size="sm"
                    busy={dots.busy === dot.id}
                    aria-label={`Stop ${dot.name}`}
                    onClick={() => setStopping(dot)}
                  >
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    busy={dots.busy === dot.id}
                    aria-label={`Start ${dot.name}`}
                    onClick={() => report(dots.start(dot))}
                  >
                    Start
                  </Button>
                ))
              }
            />
          ))
        )}
        {dots.manage && list && (
          <GroupRow
            leading={<IconTile icon="plus" />}
            label="Add a dot on this computer…"
            onSelect={(trigger) => {
              addRow.current = trigger;
              setProblem(null);
              setAdding(true);
            }}
          />
        )}
        {dots.manage && self && !self.main && (
          <GroupRow
            leading={<IconTile icon="trash" />}
            label="Remove this dot"
            detail="Stops it and removes its services, saved keys and computers."
            trailing={
              <Button
                ref={removeButton}
                size="sm"
                variant="destructive"
                onClick={() => setRemoving(true)}
              >
                Remove…
              </Button>
            }
          />
        )}
      </Group>
      <GroupNote>
        {problem ? (
          <span className="settings-computer-error" role="alert">
            {problem}
          </span>
        ) : list && !dots.manage ? (
          "Add dots from Terminal: localdot dots add <name>."
        ) : (
          "Each dot has its own address, keys and computer. Switching to one signs this browser in there."
        )}
      </GroupNote>
      {list && (
        <AddDotSheet
          open={adding}
          api={api}
          dots={list}
          returnFocus={addRow}
          onClose={() => setAdding(false)}
          onAdded={dots.refresh}
          navigate={navigate}
        />
      )}
      {self && (
        <RemoveDotDialog
          open={removing}
          dot={self}
          anchor={removeButton}
          onClose={() => setRemoving(false)}
          onRemove={async (deleteData) => {
            try {
              const reply = await removeDot(api, self.id, deleteData);
              setRemoving(false);
              if (reply.next) navigate(reply.next);
              else dots.refresh();
            } catch (error) {
              setRemoving(false);
              setProblem(dotProblem(error, `${self.name} wasn't removed.`));
            }
          }}
        />
      )}
      <StopDotDialog
        dot={stopping}
        onClose={() => setStopping(null)}
        onStop={(dot) => {
          setStopping(null);
          report(dots.stop(dot));
        }}
      />
    </div>
  );
}

function RemoveDotDialog({
  open,
  dot,
  anchor,
  onClose,
  onRemove,
}: {
  open: boolean;
  dot: DotSummary;
  anchor: RefObject<HTMLElement | null>;
  onClose(): void;
  onRemove(deleteData: boolean): Promise<void>;
}) {
  const [deleteData, setDeleteData] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      anchor={anchor}
      title={`Remove ${dot.name}?`}
      description="It stops, and its services, saved keys, computers and Tailscale address are removed. Its data folder is kept unless you tick the box. You'll go to another dot."
      body={
        <Checkbox
          label="Also delete its data"
          description="Its settings, memory and conversations, for good."
          checked={deleteData}
          onCheckedChange={setDeleteData}
        />
      }
    >
      <Button variant="quiet" onClick={onClose}>
        Cancel
      </Button>
      <Button
        variant="destructive"
        busy={busy}
        onClick={() => {
          setBusy(true);
          void onRemove(deleteData).finally(() => setBusy(false));
        }}
      >
        {`Remove ${dot.name}`}
      </Button>
    </Dialog>
  );
}

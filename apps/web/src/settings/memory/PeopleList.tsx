import { keyLikePresent, type Person } from "@localdot/protocol";
import { useRef, useState } from "react";
import { Button } from "../../ui/Button.tsx";
import { Group, GroupHead, GroupNote, GroupRow, Monogram } from "../../ui/Group.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { triggerProps } from "../../ui/Popover.tsx";
import { Skeleton } from "../../ui/Skeleton.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { showToast } from "../../ui/Toast.tsx";
import { KEY_SHAPED, SourceLink } from "./FactRow.tsx";
import { failure } from "./MemoryEditor.tsx";
import { initials, personLine, sourceLine } from "./memory-copy.ts";
import type { WhatDotKnows } from "./useWhatDotKnows.ts";

export interface PersonDraft {
  name: string;
  app: string;
  handle: string;
  note: string;
}
const BLANK: PersonDraft = { name: "", app: "", handle: "", note: "" };

export function personProblem(draft: PersonDraft): string | undefined {
  if (!draft.name.trim() || !draft.app.trim())
    return "Give a name and the app you use to reach them.";
  if ([draft.name, draft.app, draft.handle, draft.note].some((v) => /[\r\n]/.test(v)))
    return "Keep each field to one line.";
  if (
    draft.name.length > 100 ||
    draft.app.length > 40 ||
    draft.handle.length > 200 ||
    draft.note.length > 300
  )
    return "One of the fields is too long.";
  if ([draft.name, draft.handle, draft.note].some(keyLikePresent)) return KEY_SHAPED;
  return undefined;
}

function PersonForm({
  initial,
  submit,
  onSave,
  onCancel,
}: {
  initial: PersonDraft;
  submit: string;
  onSave(draft: PersonDraft): Promise<unknown>;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(initial);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof PersonDraft, label: string, placeholder: string) => (
    <TextField
      aria-label={label}
      placeholder={placeholder}
      value={draft[key]}
      autoComplete="off"
      onChange={(event) => {
        setDraft({ ...draft, [key]: event.target.value });
        setNote(null);
      }}
    />
  );
  return (
    <form
      className="ui-group-row memory-person-form"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        const problem = personProblem(draft);
        if (problem) {
          setNote(problem);
          return;
        }
        setBusy(true);
        try {
          await onSave(draft);
        } catch (error) {
          setNote(failure(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="memory-person-fields">
        {field("name", "Name", "Name")}
        {field("app", "App", "App, such as Email")}
        {field("handle", "Handle", "Number, email or ID")}
        {field("note", "Note", "Note (optional)")}
      </div>
      {note && (
        <p className="memory-note" role="alert">
          {note}
        </p>
      )}
      <div className="memory-edit-actions">
        <Button variant="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" busy={busy}>
          {submit}
        </Button>
      </div>
    </form>
  );
}

const draftOf = (person: Person): PersonDraft => ({
  name: person.name,
  app: person.app,
  handle: person.handle ?? "",
  note: person.note ?? "",
});
const fields = (draft: PersonDraft) => ({
  name: draft.name.trim(),
  app: draft.app.trim(),
  ...(draft.handle.trim() ? { handle: draft.handle.trim() } : {}),
  ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
});

function PersonRow({
  person,
  known,
  onOpenTask,
}: {
  person: Person;
  known: WhatDotKnows;
  onOpenTask?(sessionId: string): void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const source = sourceLine({ source: person.source, at: null });
  if (editing)
    return (
      <li>
        <PersonForm
          initial={draftOf(person)}
          submit="Save"
          onCancel={() => setEditing(false)}
          onSave={async (draft) => {
            const next = fields(draft);
            await known.editPerson(person, {
              ...next,
              handle: next.handle ?? null,
              note: next.note ?? null,
            });
            setEditing(false);
          }}
        />
      </li>
    );
  const remove = () =>
    void known.deletePerson(person).then(
      () =>
        showToast({
          title: `Removed ${person.name}`,
          action: {
            label: "Undo",
            onAction: () =>
              void known
                .addPerson({
                  ...fields(draftOf(person)),
                  ...(person.lastAt ? { lastAt: person.lastAt } : {}),
                  ...(person.source.kind === "task" ? { sessionId: person.source.sessionId } : {}),
                })
                .catch(() => {}),
          },
        }),
      (error) => showToast({ title: failure(error), tone: "danger" }),
    );
  return (
    <li>
      <GroupRow
        leading={<Monogram>{initials(person.name)}</Monogram>}
        label={person.name}
        detail={
          <>
            {personLine(person)}
            {person.note && <span className="memory-person-note">{person.note}</span>}
            {source.sessionId && onOpenTask && <SourceLink {...source} onOpenTask={onOpenTask} />}
          </>
        }
        trailing={
          <>
            <IconButton
              ref={more}
              icon="more-horizontal"
              label={`More for ${person.name}`}
              {...triggerProps("menu", menu)}
              onClick={() => setMenu(true)}
            />
            <Menu
              open={menu}
              onClose={() => setMenu(false)}
              anchor={more}
              align="end"
              label="Person"
            >
              <MenuItem onSelect={() => setEditing(true)}>Edit</MenuItem>
              <MenuItem onSelect={remove}>Delete</MenuItem>
            </Menu>
          </>
        }
      />
    </li>
  );
}

// The people dot reaches for the user. dot adds them as it messages someone; the user can fix or
// remove any of them, and a removed person is gone from this Mac.
export function PeopleList({
  known,
  onOpenTask,
}: {
  known: WhatDotKnows;
  onOpenTask?(sessionId: string): void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="memory-section" aria-labelledby="people-title">
      <GroupHead
        id="people-title"
        title="People"
        aside={
          !adding && (
            <Button variant="quiet" size="sm" onClick={() => setAdding(true)}>
              Add someone
            </Button>
          )
        }
      />
      <Group>
        {adding && (
          <PersonForm
            initial={BLANK}
            submit="Add"
            onCancel={() => setAdding(false)}
            onSave={async (draft) => {
              await known.addPerson(fields(draft));
              setAdding(false);
            }}
          />
        )}
        {known.phase !== "ready" && known.phase !== "error" ? (
          <div className="ui-group-row" aria-busy="true">
            <span className="ui-group-row-text">
              <Skeleton loading width="16ch" />
              <Skeleton loading width="22ch" />
            </span>
          </div>
        ) : known.people.length === 0 ? (
          !adding && (
            <GroupRow
              label="No one yet."
              detail="When dot messages, calls or emails someone for you, it notes how to reach them here."
            />
          )
        ) : (
          <ul className="memory-list" aria-label="People">
            {known.people.map((person) => (
              <PersonRow key={person.id} person={person} known={known} onOpenTask={onOpenTask} />
            ))}
          </ul>
        )}
      </Group>
      <GroupNote>dot looks people up before asking you how to reach them.</GroupNote>
    </section>
  );
}

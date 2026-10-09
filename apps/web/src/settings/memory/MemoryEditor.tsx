import type { MemoryBook, MemoryEntry } from "@localdot/protocol";
import { useState } from "react";
import type { Knowledge } from "../../agent/useKnowledge.ts";
import { Button } from "../../ui/Button.tsx";
import { Group, GroupHead, GroupNote, GroupRow } from "../../ui/Group.tsx";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { Skeleton } from "../../ui/Skeleton.tsx";
import { Spinner } from "../../ui/Spinner.tsx";
import { TextField } from "../../ui/TextField.tsx";
import { showToast } from "../../ui/Toast.tsx";
import { FactRow, factProblem } from "./FactRow.tsx";
import { MemoryRequestError } from "./memory-api.ts";
import type { WhatDotKnows } from "./useWhatDotKnows.ts";

// The two files every task starts with, and the daily notes dot looks up when it needs them.
type Shelf = MemoryBook | "notes";
const SHELVES = [
  { value: "USER.md", label: "About you" },
  { value: "MEMORY.md", label: "Notes" },
  { value: "notes", label: "Daily notes" },
] as const;
const EMPTY: Record<Shelf, string> = {
  "USER.md": "Add what dot should always know about you.",
  "MEMORY.md": "dot saves useful facts here. You can add your own.",
  notes: "dot jots down what it finds during a task here.",
};
const FOOTNOTE: Record<Shelf, string> = {
  "USER.md": "Pinned facts come first in every task.",
  "MEMORY.md": "Pinned facts come first in every task.",
  notes: "dot looks these up when it needs them. A task doesn't start with them.",
};

// Pinned facts first in file order, then the newest, undated ones last: the order a task reads.
export function factOrder(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return entries
    .map((entry, at) => ({ entry, at }))
    .sort((a, b) => {
      if (a.entry.pinned !== b.entry.pinned) return a.entry.pinned ? -1 : 1;
      if (a.entry.pinned) return a.at - b.at;
      if (Boolean(a.entry.at) !== Boolean(b.entry.at)) return a.entry.at ? -1 : 1;
      if (a.entry.at && b.entry.at && a.entry.at !== b.entry.at)
        return a.entry.at < b.entry.at ? 1 : -1;
      return b.at - a.at;
    })
    .map(({ entry }) => entry);
}

// Why an Undo did not happen.
export function undoFailure(error: unknown): string {
  if (error instanceof MemoryRequestError && error.reason === "stale")
    return "Couldn't undo: memory changed since.";
  if (error instanceof MemoryRequestError && error.reason === "missing")
    return "That can't be undone any more.";
  return failure(error);
}

export function failure(error: unknown): string {
  if (error instanceof MemoryRequestError) {
    if (error.reason === "busy")
      return "Memory can't change while you have control of the computer.";
    if (error.reason === "stale")
      return "Memory changed meanwhile. It's up to date now; try again.";
    if (error.reason === "invalid")
      return "localDot couldn't save that. Check the text and try again.";
    if (error.reason === "full") return "That's as much as dot can keep. Remove something first.";
    if (error.reason === "unreadable")
      return "localDot couldn't read what dot knows. Try again later.";
  }
  return "Couldn't reach localDot. Try again.";
}

export function MemoryEditor({
  known,
  knowledge,
  onOpenTask,
}: {
  known: WhatDotKnows;
  knowledge?: Knowledge;
  onOpenTask?(sessionId: string): void;
}) {
  const [shelf, setShelf] = useState<Shelf>("USER.md");
  const [fact, setFact] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [markdown, setMarkdown] = useState(false);
  const notes = shelf === "notes";
  const noun = notes ? "Note" : "Fact";
  const facts = notes ? known.notes : factOrder(known.files[shelf]);
  const pinned = facts.filter((entry) => entry.pinned);
  const rest = facts.filter((entry) => !entry.pinned);
  const label = SHELVES.find((s) => s.value === shelf)?.label;
  const done = (title: string) => (changeId: string) =>
    showToast({
      title,
      action: {
        label: "Undo",
        onAction: () =>
          void known
            .undo(changeId)
            .catch((error) => showToast({ title: undoFailure(error), tone: "danger" })),
      },
    });
  const failed = (error: unknown) => showToast({ title: failure(error), tone: "danger" });
  const add = async () => {
    if (adding || notes) return;
    const text = fact.trim();
    const issue = factProblem(text);
    if (issue) {
      setProblem(fact ? issue : null);
      return;
    }
    setAdding(true);
    try {
      done("Fact saved")(await known.addFact(shelf, text));
      setFact("");
    } catch (error) {
      failed(error);
    } finally {
      setAdding(false);
    }
  };
  const raw =
    knowledge?.memory && !notes
      ? shelf === "USER.md"
        ? knowledge.memory.user
        : knowledge.memory.memory
      : null;
  const shown = markdown && raw !== null;
  const row = (entry: MemoryEntry, at: number, list: readonly MemoryEntry[]) => (
    <FactRow
      key={entry.id}
      entry={entry}
      noun={noun}
      heading={
        at === 0 && list === pinned ? (
          <p id="memory-pinned" className="memory-label">
            Always remembered
          </p>
        ) : undefined
      }
      onOpenTask={onOpenTask}
      onSave={(text) => known.editFact(entry, { text }).then(done(`${noun} saved`))}
      onTogglePin={
        notes
          ? undefined
          : () =>
              void known
                .editFact(entry, { pinned: !entry.pinned })
                .then(
                  done(entry.pinned ? "No longer always remembered" : "Always remembered"),
                  failed,
                )
      }
      onDelete={() => void known.deleteFact(entry).then(done(`${noun} deleted`), failed)}
    />
  );
  return (
    <section className="memory-section" aria-labelledby="memory-title">
      <GroupHead
        id="memory-title"
        title="Memory"
        aside={
          <SegmentedControl
            size={24}
            aria-label="Memory file"
            items={SHELVES}
            value={shelf}
            onValueChange={(value) => {
              setShelf(value as Shelf);
              setProblem(null);
            }}
          />
        }
      />
      <Group>
        {!notes && (
          <form
            className="ui-group-row memory-add"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <TextField
              aria-label="New fact"
              placeholder={
                shelf === "USER.md" ? "Add something about you" : "Add a fact to remember"
              }
              value={fact}
              autoComplete="off"
              aria-invalid={problem ? true : undefined}
              onChange={(event) => {
                setFact(event.target.value);
                setProblem(null);
              }}
            />
            <Button type="submit" size="sm" busy={adding}>
              Add
            </Button>
            {problem && (
              <p className="memory-note" role="alert">
                {problem}
              </p>
            )}
          </form>
        )}
        {known.phase !== "ready" && known.phase !== "error" ? (
          <div className="ui-group-row" aria-busy="true">
            <span className="ui-group-row-text">
              <Skeleton loading width="24ch" />
              <Skeleton loading width="14ch" />
            </span>
          </div>
        ) : known.phase === "error" ? (
          <GroupRow
            label="Memory couldn't be read."
            trailing={
              <Button variant="quiet" size="sm" onClick={known.reload}>
                Try again
              </Button>
            }
          />
        ) : facts.length === 0 ? (
          <GroupRow label="Nothing yet." detail={EMPTY[shelf]} />
        ) : (
          <>
            {pinned.length > 0 && (
              <ul className="memory-list" aria-labelledby="memory-pinned">
                {pinned.map(row)}
              </ul>
            )}
            {rest.length > 0 && (
              <ul className="memory-list" aria-label={label}>
                {rest.map(row)}
              </ul>
            )}
          </>
        )}
        {knowledge && !notes && (
          <GroupRow
            label={shown ? "Hide the file" : "Show the file"}
            detail={`${known.dir || "~/.localdot/memory"}/${shelf}`}
            trailing={
              markdown && knowledge.memoryPhase === "loading" ? <Spinner size={14} /> : undefined
            }
            onSelect={() => {
              if (shown) setMarkdown(false);
              else if (knowledge.memoryPhase !== "loading") {
                setMarkdown(true);
                knowledge.rereadMemory();
              }
            }}
          />
        )}
      </Group>
      <GroupNote>{FOOTNOTE[shelf]}</GroupNote>
      {shown && <pre className="settings-well memory-raw">{raw || "Nothing yet."}</pre>}
    </section>
  );
}

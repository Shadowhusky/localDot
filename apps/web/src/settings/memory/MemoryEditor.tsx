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

const BOOKS = [
  { value: "USER.md", label: "About you" },
  { value: "MEMORY.md", label: "Notes" },
] as const;
const EMPTY: Record<MemoryBook, string> = {
  "USER.md": "Add what dot should always know about you.",
  "MEMORY.md": "dot saves useful facts here. You can add your own.",
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

export function failure(error: unknown): string {
  if (error instanceof MemoryRequestError) {
    if (error.reason === "busy")
      return "Memory can't change while you have control of the computer.";
    if (error.reason === "stale")
      return "Memory changed meanwhile. It's up to date now; try again.";
    if (error.reason === "invalid")
      return "localDot couldn't save that. Check the text and try again.";
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
  const [book, setBook] = useState<MemoryBook>("USER.md");
  const [fact, setFact] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [markdown, setMarkdown] = useState(false);
  const facts = factOrder(known.files[book]);
  const done = (title: string) => (changeId: string) =>
    showToast({
      title,
      action: {
        label: "Undo",
        onAction: () =>
          void known
            .undo(changeId)
            .catch(() =>
              showToast({ title: "Couldn't undo: memory changed since.", tone: "danger" }),
            ),
      },
    });
  const failed = (error: unknown) => showToast({ title: failure(error), tone: "danger" });
  const add = async () => {
    if (adding) return;
    const text = fact.trim();
    const issue = factProblem(text);
    if (issue) {
      setProblem(fact ? issue : null);
      return;
    }
    setAdding(true);
    try {
      done("Fact saved")(await known.addFact(book, text));
      setFact("");
    } catch (error) {
      failed(error);
    } finally {
      setAdding(false);
    }
  };
  const raw = knowledge?.memory
    ? book === "USER.md"
      ? knowledge.memory.user
      : knowledge.memory.memory
    : null;
  const shown = markdown && raw !== null;
  return (
    <section className="memory-section" aria-labelledby="memory-title">
      <GroupHead
        id="memory-title"
        title="Memory"
        aside={
          <SegmentedControl
            size={24}
            aria-label="Memory file"
            items={BOOKS}
            value={book}
            onValueChange={(value) => {
              setBook(value as MemoryBook);
              setProblem(null);
            }}
          />
        }
      />
      <Group>
        <form
          className="ui-group-row memory-add"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <TextField
            aria-label="New fact"
            placeholder={book === "USER.md" ? "Add something about you" : "Add a fact to remember"}
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
          <GroupRow label="Nothing yet." detail={EMPTY[book]} />
        ) : (
          <ul className="memory-list" aria-label={book === "USER.md" ? "About you" : "Notes"}>
            {facts.map((entry) => (
              <FactRow
                key={entry.id}
                entry={entry}
                onOpenTask={onOpenTask}
                onSave={(text) => known.editFact(entry, { text }).then(done("Fact saved"))}
                onTogglePin={() =>
                  void known
                    .editFact(entry, { pinned: !entry.pinned })
                    .then(
                      done(entry.pinned ? "No longer always remembered" : "Always remembered"),
                      failed,
                    )
                }
                onDelete={() => void known.deleteFact(entry).then(done("Fact deleted"), failed)}
              />
            ))}
          </ul>
        )}
        {knowledge && (
          <GroupRow
            label={shown ? "Hide the file" : "Show the file"}
            detail={`${known.dir || "~/.localdot/memory"}/${book}`}
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
      <GroupNote>Pinned facts come first in every task.</GroupNote>
      {shown && <pre className="settings-well memory-raw">{raw || "Nothing yet."}</pre>}
    </section>
  );
}

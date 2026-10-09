import type {
  AddPersonRequest,
  EditPersonRequest,
  MemoryBook,
  MemoryEntry,
  Person,
  RecentTask,
} from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.ts";
import {
  addEntry,
  addPerson,
  deleteEntry,
  deletePerson,
  editEntry,
  editPerson,
  loadEntries,
  loadPeople,
  loadRecent,
  MemoryRequestError,
  undoChange,
} from "./memory-api.ts";

export type KnowsPhase = "idle" | "loading" | "ready" | "error";
interface Known {
  phase: KnowsPhase;
  dir: string;
  files: Record<MemoryBook, MemoryEntry[]>;
  people: Person[];
  recent: RecentTask[];
}
const EMPTY: Known = {
  phase: "idle",
  dir: "",
  files: { "USER.md": [], "MEMORY.md": [] },
  people: [],
  recent: [],
};

// What dot knows, read while Settings is open: memory's facts, the people dot reaches for the user
// and what the next task hears about recent ones. Every change reads all of it again.
export function useWhatDotKnows(api: ApiClient, open: boolean) {
  const [known, setKnown] = useState<Known>(EMPTY);
  const loading = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    setKnown((old) => (old.phase === "ready" ? old : { ...old, phase: "loading" }));
    try {
      const [entries, people, recent] = await Promise.all([
        loadEntries(api, controller.signal),
        loadPeople(api, controller.signal),
        loadRecent(api, controller.signal),
      ]);
      if (!mounted.current || controller.signal.aborted) return;
      setKnown({
        phase: "ready",
        dir: entries.dir,
        files: Object.fromEntries(entries.files.map((f) => [f.file, f.entries])) as Known["files"],
        people,
        recent: recent.tasks,
      });
    } catch {
      if (mounted.current && !controller.signal.aborted)
        setKnown((old) => (old.phase === "ready" ? old : { ...old, phase: "error" }));
    } finally {
      if (loading.current === controller) loading.current = null;
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    if (open) void load();
    else {
      loading.current?.abort();
      setKnown(EMPTY);
    }
    return () => loading.current?.abort();
  }, [open, load]);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // A write, then a fresh read; a stale write reads again before it fails.
  const write = useCallback(
    async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        const out = await work();
        void load();
        return out;
      } catch (error) {
        if (error instanceof MemoryRequestError && error.reason !== "offline") void load();
        throw error;
      }
    },
    [load],
  );
  return {
    ...known,
    reload: () => void load(),
    addFact: (file: MemoryBook, text: string) =>
      write(async () => (await addEntry(api, file, text)).changeId),
    editFact: (entry: MemoryEntry, patch: { text?: string; pinned?: boolean }) =>
      write(async () => (await editEntry(api, entry, patch)).changeId),
    deleteFact: (entry: MemoryEntry) => write(async () => (await deleteEntry(api, entry)).changeId),
    undo: (changeId: string) => write(() => undoChange(api, changeId)),
    addPerson: (person: AddPersonRequest) => write(() => addPerson(api, person)),
    editPerson: (person: Person, patch: Omit<EditPersonRequest, "revision">) =>
      write(() => editPerson(api, person, patch)),
    deletePerson: (person: Person) => write(() => deletePerson(api, person)),
  };
}
export type WhatDotKnows = ReturnType<typeof useWhatDotKnows>;

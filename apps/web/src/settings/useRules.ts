import type { AutonomyRule } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { ControlFailure } from "../agent/control-api.ts";
import { loadRules, removeRule, resetRules } from "../agent/safety-api.ts";
import type { ApiClient } from "../lib/api.ts";

export interface RulesView {
  phase: "loading" | "ready" | "error";
  rules: readonly AutonomyRule[];
  unreadable: string | null;
  removing: string | null;
  failed: string | null;
  resetting: boolean;
  remove(id: string): void;
  reset(): void;
  reload(): void;
}
interface List {
  phase: RulesView["phase"];
  rules: readonly AutonomyRule[];
  unreadable: string | null;
}

// The saved "Always allow" rules. They change on the spot, outside the Settings draft.
export function useRules(api: ApiClient, open: boolean): RulesView {
  const [list, setList] = useState<List>({ phase: "loading", rules: [], unreadable: null });
  const [removing, setRemoving] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const reading = useRef<AbortController | null>(null);
  const changing = useRef<AbortController | null>(null);
  const read = useCallback(async () => {
    reading.current?.abort();
    const abort = new AbortController();
    reading.current = abort;
    setList((old) => ({ ...old, phase: "loading" }));
    try {
      const value = await loadRules(api, abort.signal);
      if (!abort.signal.aborted)
        setList({ phase: "ready", rules: value.rules, unreadable: value.error ?? null });
    } catch {
      if (!abort.signal.aborted) setList({ phase: "error", rules: [], unreadable: null });
    }
  }, [api]);
  useEffect(() => {
    if (!open) return;
    setFailed(null);
    void read();
    return () => {
      reading.current?.abort();
      changing.current?.abort();
      changing.current = null;
      setRemoving(null);
      setResetting(false);
    };
  }, [open, read]);
  const change = (
    work: (signal: AbortSignal) => Promise<void>,
    done: (error?: unknown) => void,
  ) => {
    if (changing.current) return;
    const abort = new AbortController();
    changing.current = abort;
    Promise.resolve()
      .then(() => work(abort.signal))
      .then(
        () => done(),
        (error: unknown) => done(error ?? new Error("failed")),
      );
    return abort;
  };
  const drop = (id: string) =>
    setList((old) => ({ ...old, rules: old.rules.filter((rule) => rule.id !== id) }));
  const remove = (id: string) => {
    setFailed(null);
    const abort = change(
      (signal) => removeRule(api, id, signal),
      (error) => {
        if (abort?.signal.aborted || changing.current !== abort) return;
        changing.current = null;
        setRemoving(null);
        if (!error || (error instanceof ControlFailure && error.status === 404)) drop(id);
        else setFailed(id);
      },
    );
    if (abort) setRemoving(id);
  };
  const reset = () => {
    const abort = change(
      (signal) => resetRules(api, signal),
      () => {
        if (abort?.signal.aborted || changing.current !== abort) return;
        changing.current = null;
        setResetting(false);
        void read();
      },
    );
    if (abort) setResetting(true);
  };
  return { ...list, removing, failed, resetting, remove, reset, reload: () => void read() };
}

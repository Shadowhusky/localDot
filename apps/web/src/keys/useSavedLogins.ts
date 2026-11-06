import type { LoginImport, SavedLogin } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  importLogins,
  loadLogins,
  loginProblem,
  removeLogin,
  saveLogin,
} from "./saved-logins-api.ts";

export interface SavedLoginsView {
  logins: readonly SavedLogin[];
  loading: boolean;
  failure: string | null;
  // A change is on its way; another waits until it settles.
  busy: boolean;
  importing: boolean;
  summary: LoginImport | null;
  importProblem: string | null;
  save(login: { origin: string; username: string; password?: string }): Promise<SavedLogin>;
  remove(origin: string): Promise<void>;
  importFile(file: File): Promise<void>;
  dismissSummary(): void;
}

// Saved logins while Keys can show them; `open` says keyd can answer, and a new `epoch` (keyd came
// back, the vault was unlocked) lists them again.
export function useSavedLogins(api: ApiClient, open: boolean, epoch: string): SavedLoginsView {
  const [logins, setLogins] = useState<readonly SavedLogin[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<LoginImport | null>(null);
  const [importProblem, setImportProblem] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const changing = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a change or a new epoch lists again
  useEffect(() => {
    if (!open) {
      setLogins([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    loadLogins(api)
      .then((list) => {
        if (cancelled) return;
        setLogins(list);
        setFailure(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailure(loginProblem(err, "Couldn't load your saved logins."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, open, epoch, version]);

  const change = useCallback(async <T>(work: () => Promise<T>): Promise<T> => {
    if (changing.current) throw new Error("Another change is on its way.");
    changing.current = true;
    setBusy(true);
    try {
      return await work();
    } finally {
      changing.current = false;
      setBusy(false);
      setVersion((now) => now + 1);
    }
  }, []);

  const save = useCallback(
    (login: { origin: string; username: string; password?: string }) =>
      change(() => saveLogin(api, login)),
    [api, change],
  );
  const remove = useCallback(
    (origin: string) => change(() => removeLogin(api, origin)),
    [api, change],
  );
  const importFile = useCallback(
    async (file: File) => {
      setImporting(true);
      setSummary(null);
      setImportProblem(null);
      try {
        setSummary(await change(() => importLogins(api, file)));
      } catch (err) {
        setImportProblem(loginProblem(err, "The import didn't finish. Try again."));
      } finally {
        setImporting(false);
      }
    },
    [api, change],
  );
  const dismissSummary = useCallback(() => {
    setSummary(null);
    setImportProblem(null);
  }, []);
  return {
    logins,
    loading,
    failure,
    busy,
    importing,
    summary,
    importProblem,
    save,
    remove,
    importFile,
    dismissSummary,
  };
}

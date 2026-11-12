import { useCallback, useEffect, useState } from "react";
import {
  type BrowserEngineRequest,
  BrowserEngineStatus,
} from "../../../../packages/protocol/src/browser-engine.ts";
import { t } from "../i18n/index.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";

const ENGINE_PATH = "/api/browser/engine";
// How often an install under way is read; otherwise only when opened or changed.
const INSTALLING_MS = 3000;

export interface BrowserEngineView {
  status: BrowserEngineStatus | null;
  // Which change is being asked for.
  pending: "chrome" | "chromium" | "restore" | "delete" | null;
  failure: string | null;
  // Resolves false, with `failure` set, when the daemon refused.
  choose(request: BrowserEngineRequest): Promise<boolean>;
  restoreBackup(): void;
  deleteBackup(): void;
}

const failureOf = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.status === 409 && error.message ? error.message : fallback;

export function useBrowserEngine(api: ApiClient, visible: boolean): BrowserEngineView {
  const [status, setStatus] = useState<BrowserEngineStatus | null>(null);
  const [pending, setPending] = useState<BrowserEngineView["pending"]>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const installing = status?.installing === true;

  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      api
        .get<unknown>(ENGINE_PATH, { signal: abort.signal })
        .then((value) => setStatus(BrowserEngineStatus.parse(value)))
        .catch(() => {})
        .finally(() => {
          if (!abort.signal.aborted && installing) timer = setTimeout(read, INSTALLING_MS);
        });
    };
    read();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, visible, installing]);

  const change = useCallback(
    async (
      kind: NonNullable<BrowserEngineView["pending"]>,
      work: () => Promise<unknown>,
      fallback: string,
    ) => {
      setPending(kind);
      setFailure(null);
      try {
        setStatus(BrowserEngineStatus.parse(await work()));
        return true;
      } catch (error) {
        setFailure(failureOf(error, fallback));
        return false;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  const choose = useCallback(
    (request: BrowserEngineRequest) =>
      change(
        request.choice,
        () => api.put(ENGINE_PATH, request),
        request.choice === "chrome"
          ? t`Couldn't start installing Google Chrome. Try again.`
          : t`Couldn't switch to Chromium. Try again.`,
      ),
    [api, change],
  );
  const restoreBackup = useCallback(() => {
    void change(
      "restore",
      () => api.post(`${ENGINE_PATH}/restore`),
      t`Couldn't go back to the backup. Try again.`,
    );
  }, [api, change]);
  const deleteBackup = useCallback(() => {
    void change(
      "delete",
      async () => {
        await api.del(`${ENGINE_PATH}/backup`);
        return api.get(ENGINE_PATH);
      },
      t`Couldn't delete the backup. Try again.`,
    );
  }, [api, change]);

  return { status, pending, failure, choose, restoreBackup, deleteBackup };
}

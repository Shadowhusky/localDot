import type {
  CatalogEntry,
  ConnectorDraft,
  ConnectorPatch,
  ConnectorView,
} from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import type { ApiClient } from "../lib/api.ts";
import {
  addConnector,
  cancelSignIn,
  disconnectConnector,
  loadConnectors,
  problemOf,
  refreshConnector,
  removeConnector,
  saveConnectorKey,
  startSignIn,
  updateConnector,
} from "./connectors-api.ts";

// While an app connects, its status is asked for again this often.
export const CONNECTING_POLL_MS = 2000;

export type ConnectorsPhase = "loading" | "ready" | "error";

export interface ConnectorKey {
  hosts: readonly string[];
  header: string;
  format: "bearer" | "raw";
  value: string;
}

export interface ConnectorsView {
  phase: ConnectorsPhase;
  connectors: readonly ConnectorView[];
  catalog: readonly CatalogEntry[];
  // The app with a change on its way, by id; "new" while one is being added.
  pending: string | null;
  // What went wrong last, by the app's id ("new" for adding one).
  failure: { id: string; text: string } | null;
  reload(): void;
  // Adds an app, saving its key first when it has one. Resolves to the app, or null on failure.
  add(draft: ConnectorDraft & { id: string }, key?: ConnectorKey): Promise<ConnectorView | null>;
  update(id: string, patch: ConnectorPatch): Promise<boolean>;
  saveKey(id: string, key: ConnectorKey, patch?: ConnectorPatch): Promise<boolean>;
  refresh(id: string): void;
  remove(id: string): Promise<boolean>;
  // Has the daemon open the app's sign-in page in the browser on its own computer.
  signIn(id: string): void;
  cancelSignIn(id: string): void;
  disconnect(id: string): void;
  // A sign-in page the daemon couldn't open itself, for this browser to open.
  page: { id: string; url: string } | null;
  clear(): void;
}

export function useConnectors(api: ApiClient, visible: boolean): ConnectorsView {
  const [phase, setPhase] = useState<ConnectorsPhase>("loading");
  const [connectors, setConnectors] = useState<readonly ConnectorView[]>([]);
  const [catalog, setCatalog] = useState<readonly CatalogEntry[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<ConnectorsView["failure"]>(null);
  const [page, setPage] = useState<ConnectorsView["page"]>(null);
  const [attempt, setAttempt] = useState(0);
  const loaded = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt is what asks again
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    loadConnectors(api, abort.signal).then(
      (list) => {
        loaded.current = true;
        setConnectors(list.connectors);
        setCatalog(list.catalog);
        setPhase("ready");
      },
      () => {
        if (!abort.signal.aborted && !loaded.current) setPhase("error");
      },
    );
    return () => abort.abort();
  }, [api, visible, attempt]);

  // Back from signing in to an app in another tab: what changed shows at once.
  useEffect(() => {
    if (!visible) return;
    const again = () => setAttempt((n) => n + 1);
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [visible]);

  // An app still connecting, or waiting for the user in the browser, is asked about again until it
  // settles.
  const connecting = connectors.some((c) => c.status === "connecting" || c.signIn);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each fresh list waits its turn again
  useEffect(() => {
    if (!visible || !connecting) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), CONNECTING_POLL_MS);
    return () => clearTimeout(timer);
  }, [visible, connecting, connectors]);

  const put = useCallback((view: ConnectorView) => {
    setConnectors((now) =>
      now.some((c) => c.id === view.id)
        ? now.map((c) => (c.id === view.id ? view : c))
        : [...now, view],
    );
  }, []);

  const run = useCallback(
    async <T>(id: string, fallback: string, work: () => Promise<T>): Promise<T | null> => {
      setPending(id);
      setFailure(null);
      try {
        return await work();
      } catch (error) {
        setFailure({ id, text: problemOf(error, fallback) });
        return null;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  const add = useCallback<ConnectorsView["add"]>(
    (draft, key) =>
      run("new", t`Couldn't add the app. Try again.`, async () => {
        if (key) await saveConnectorKey(api, draft.id, key, key.value);
        const view = await addConnector(api, draft);
        put(view);
        return view;
      }),
    [api, put, run],
  );

  const update = useCallback<ConnectorsView["update"]>(
    async (id, patch) =>
      (await run(id, t`Couldn't save that. Try again.`, async () => {
        put(await updateConnector(api, id, patch));
        return true;
      })) ?? false,
    [api, put, run],
  );

  const saveKey = useCallback<ConnectorsView["saveKey"]>(
    async (id, key, patch) =>
      (await run(id, t`Couldn't save the key. Try again.`, async () => {
        await saveConnectorKey(api, id, key, key.value);
        put(patch ? await updateConnector(api, id, patch) : await refreshConnector(api, id));
        return true;
      })) ?? false,
    [api, put, run],
  );

  const refresh = useCallback(
    (id: string) => {
      void run(id, t`Couldn't check the app. Try again.`, async () =>
        put(await refreshConnector(api, id)),
      );
    },
    [api, put, run],
  );

  const remove = useCallback<ConnectorsView["remove"]>(
    async (id) =>
      (await run(id, t`Couldn't remove the app. Try again.`, async () => {
        await removeConnector(api, id);
        setConnectors((now) => now.filter((c) => c.id !== id));
        return true;
      })) ?? false,
    [api, run],
  );

  const signIn = useCallback(
    (id: string) => {
      setPage(null);
      void run(id, t`Couldn't open the app's sign-in. Try again.`, async () => {
        const started = await startSignIn(api, id);
        if (started.url) setPage({ id, url: started.url });
        setConnectors((await loadConnectors(api)).connectors);
      });
    },
    [api, run],
  );

  const stopSignIn = useCallback(
    (id: string) => {
      setPage(null);
      void run(id, t`Couldn't cancel that. Try again.`, async () => {
        await cancelSignIn(api, id);
        setAttempt((n) => n + 1);
      });
    },
    [api, run],
  );

  const disconnect = useCallback(
    (id: string) => {
      void run(id, t`Couldn't disconnect the app. Try again.`, async () =>
        put(await disconnectConnector(api, id)),
      );
    },
    [api, put, run],
  );

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const clear = useCallback(() => setFailure(null), []);

  return {
    phase,
    connectors,
    catalog,
    pending,
    failure,
    reload,
    add,
    update,
    saveKey,
    refresh,
    remove,
    signIn,
    cancelSignIn: stopSignIn,
    disconnect,
    page,
    clear,
  };
}

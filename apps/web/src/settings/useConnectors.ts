import type {
  CatalogEntry,
  ConnectorDraft,
  ConnectorPatch,
  ConnectorView,
} from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  addConnector,
  loadConnectors,
  problemOf,
  refreshConnector,
  removeConnector,
  saveConnectorKey,
  signInUrl,
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
  // Opens the app's sign-in page in a new tab; the tab is opened in the click (or given, when the
  // click had work to do first), so no pop-up blocker stops it.
  signIn(id: string, tab?: Window | null): void;
  clear(): void;
}

export function useConnectors(api: ApiClient, visible: boolean): ConnectorsView {
  const [phase, setPhase] = useState<ConnectorsPhase>("loading");
  const [connectors, setConnectors] = useState<readonly ConnectorView[]>([]);
  const [catalog, setCatalog] = useState<readonly CatalogEntry[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<ConnectorsView["failure"]>(null);
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

  // An app still connecting is asked about again until it settles.
  const connecting = connectors.some((c) => c.status === "connecting");
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
      run("new", "Couldn't add the app. Try again.", async () => {
        if (key) await saveConnectorKey(api, draft.id, key, key.value);
        const view = await addConnector(api, draft);
        put(view);
        return view;
      }),
    [api, put, run],
  );

  const update = useCallback<ConnectorsView["update"]>(
    async (id, patch) =>
      (await run(id, "Couldn't save that. Try again.", async () => {
        put(await updateConnector(api, id, patch));
        return true;
      })) ?? false,
    [api, put, run],
  );

  const saveKey = useCallback<ConnectorsView["saveKey"]>(
    async (id, key, patch) =>
      (await run(id, "Couldn't save the key. Try again.", async () => {
        await saveConnectorKey(api, id, key, key.value);
        put(patch ? await updateConnector(api, id, patch) : await refreshConnector(api, id));
        return true;
      })) ?? false,
    [api, put, run],
  );

  const refresh = useCallback(
    (id: string) => {
      void run(id, "Couldn't check the app. Try again.", async () =>
        put(await refreshConnector(api, id)),
      );
    },
    [api, put, run],
  );

  const remove = useCallback<ConnectorsView["remove"]>(
    async (id) =>
      (await run(id, "Couldn't remove the app. Try again.", async () => {
        await removeConnector(api, id);
        setConnectors((now) => now.filter((c) => c.id !== id));
        return true;
      })) ?? false,
    [api, run],
  );

  const signIn = useCallback(
    (id: string, given?: Window | null) => {
      const tab = given === undefined ? window.open("", "_blank") : given;
      void run(id, "Couldn't open the app's sign-in. Try again.", async () => {
        const url = await signInUrl(api, id);
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else window.open(url, "_blank", "noopener");
      }).then((opened) => {
        if (opened === null) tab?.close();
      });
    },
    [api, run],
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
    clear,
  };
}

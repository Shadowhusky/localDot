import type { KeyMetadata, SecretBinding } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  deleteKey,
  type KeydHealth,
  KeyProblem,
  type KeyRecord,
  loadHealth,
  loadKeys,
  problemText,
  saveKey,
  unlockKeys,
  vaultLocked,
} from "./keys-api.ts";

export interface KeysController {
  revision?: number;
  health: KeydHealth | null;
  keys: KeyRecord[];
  loadError: string | null;
  metadataReady?: boolean;
  // A save or a removal is in flight; another change is refused until it settles.
  busy: boolean;
  updateMetadata?(id: string, metadata: KeyMetadata): Promise<void>;
  save(
    binding: SecretBinding,
    value: string,
    metadata?: KeyMetadata,
  ): Promise<{ restart: boolean; key?: KeyRecord }>;
  remove(id: string): Promise<void>;
  // Opens the passphrase vault, or gives a new one its passphrase.
  unlock?(passphrase: string): Promise<void>;
}

export type KeyStatus = {
  label: string;
  state: "unknown" | "ok" | "offline" | "audit" | "locked" | "reenter" | "guard";
  // The button's accessible name when a hollow dot alone tells the state (network protection).
  spoken?: string;
};

// Says when key protection is off; while keyd cannot write its audit log it swaps no key, which the
// user sees as every keyed request failing, so that is said too, as is a key to enter again; and
// network protection that does not know the public address is never silent (the sheet says why).
function attentionText({ reenter = 0, rebound = 0 }: KeydHealth): string {
  if (reenter && rebound) return "keys need your attention";
  if (rebound)
    return rebound === 1
      ? "a key was changed outside localDot"
      : "keys were changed outside localDot";
  return reenter === 1 ? "a key needs re-entering" : "keys need re-entering";
}

export function keyStatus(health: KeydHealth | null): KeyStatus {
  if (!health) return { label: "Keys", state: "unknown" };
  if (!health.online) return { label: "Key protection off", state: "offline" };
  if (health.audit && !health.audit.ok) return { label: "Keys held", state: "audit" };
  if (vaultLocked(health)) return { label: "Keys locked", state: "locked" };
  if (health.reenter || health.rebound)
    return { label: "Keys", state: "reenter", spoken: `Keys, ${attentionText(health)}` };
  if (health.hairpin?.state !== "active") {
    const guard = health.hairpin?.state === "off" ? "off" : "checking";
    return { label: "Keys", state: "guard", spoken: `Keys, network protection ${guard}` };
  }
  return { label: "Keys", state: "ok" };
}

export function useKeys(api: ApiClient, everyMs = 5000): KeysController {
  const [health, setHealth] = useState<KeydHealth | null>(null);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [metadataReady, setMetadataReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const previousApi = useRef(api);

  // biome-ignore lint/correctness/useExhaustiveDependencies: saving/deleting starts a fresh poll and invalidates the previous list request
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listed = false;
    let bootId: string | undefined;
    let reenter: number | undefined;
    let rebound: number | undefined;
    setMetadataReady(false);
    if (previousApi.current !== api) {
      previousApi.current = api;
      setHealth(null);
      setKeys([]);
      setLoadError(null);
    }
    const poll = async () => {
      // One poll at a time: a slower, older health response must not replace a
      // newer state. A failed list is retried on the next health poll.
      const next = await loadHealth(api).catch((): KeydHealth => ({ online: false }));
      if (cancelled) return;
      setHealth(next);
      if (!next.online) {
        setMetadataReady(false);
        listed = false;
        setKeys([]);
        setLoadError(null);
      } else if (
        !listed ||
        next.bootId !== bootId ||
        next.reenter !== reenter ||
        next.rebound !== rebound
      ) {
        // A key keyd found it must have entered again, or changed outside localDot, is relisted
        // in place.
        setMetadataReady(false);
        if (listed && next.bootId !== bootId) setKeys([]);
        bootId = next.bootId;
        reenter = next.reenter;
        rebound = next.rebound;
        try {
          const list = await loadKeys(api);
          if (cancelled) return;
          setKeys(list);
          setMetadataReady(true);
          setLoadError(null);
          listed = true;
        } catch (err) {
          if (cancelled) return;
          listed = false;
          setLoadError(problemText(err));
        }
      }
      if (!cancelled) timer = setTimeout(poll, everyMs);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, everyMs, version]);

  // Locked before the health lookup or sealing starts: a later removal must not reach keyd before an
  // earlier save, which would then recreate the key.
  const change = useCallback(async <T>(operation: () => Promise<T>): Promise<T> => {
    if (changing.current) throw new KeyProblem("Another key change is in progress.");
    changing.current = true;
    setBusy(true);
    try {
      return await operation();
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }, []);

  const save = useCallback(
    (binding: SecretBinding, value: string, metadata?: KeyMetadata) =>
      change(async () => {
        const { restart, key } = metadata
          ? await saveKey(api, binding, value, undefined, metadata)
          : await saveKey(api, binding, value);
        setVersion((v) => v + 1);
        return { restart, key };
      }),
    [api, change],
  );

  const remove = useCallback(
    (id: string) =>
      change(async () => {
        await deleteKey(api, id);
        setVersion((v) => v + 1);
      }),
    [api, change],
  );

  // The open vault shows at once; the poll that follows lists the keys it now holds.
  const unlock = useCallback(
    async (passphrase: string) => {
      const vault = await unlockKeys(api, passphrase);
      if (vault) setHealth((now) => (now ? { ...now, vault } : now));
      setVersion((v) => v + 1);
    },
    [api],
  );

  const updateMetadata = useCallback(
    (id: string, metadata: KeyMetadata) =>
      change(async () => {
        await api.put(`/api/keys/${encodeURIComponent(id)}/metadata`, metadata);
        setVersion((v) => v + 1);
      }),
    [api, change],
  );
  return {
    health,
    keys,
    loadError,
    metadataReady,
    busy,
    save,
    remove,
    unlock,
    updateMetadata,
    revision: version,
  };
}

import type { SecretBinding } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  deleteKey,
  type KeydHealth,
  type KeyRecord,
  loadHealth,
  loadKeys,
  problemText,
  saveKey,
} from "./keys-api.ts";

export interface KeysController {
  health: KeydHealth | null;
  keys: KeyRecord[];
  loadError: string | null;
  save(binding: SecretBinding, value: string): Promise<{ restart: boolean }>;
  remove(id: string): Promise<void>;
}

export type KeyStatus = {
  label: string;
  state: "unknown" | "ok" | "offline" | "audit" | "guard";
  // The button's accessible name when a hollow dot alone tells the state (the hairpin guard).
  spoken?: string;
};

// The spec's "Key layer offline"; while keyd cannot write its audit log it swaps no key, which the
// user sees as every keyed request failing, so that is said too; and a hairpin guard that does not
// know the public address is never silent (the sheet says why).
export function keyStatus(health: KeydHealth | null): KeyStatus {
  if (!health) return { label: "Keys", state: "unknown" };
  if (!health.online) return { label: "Key layer offline", state: "offline" };
  if (health.audit && !health.audit.ok) return { label: "Keys on hold", state: "audit" };
  if (health.hairpin?.state !== "active") {
    const guard = health.hairpin?.state === "off" ? "off" : "unknown";
    return { label: "Keys", state: "guard", spoken: `Keys, hairpin guard ${guard}` };
  }
  return { label: "Keys", state: "ok" };
}

export function useKeys(api: ApiClient, everyMs = 5000): KeysController {
  const [health, setHealth] = useState<KeydHealth | null>(null);
  const [keys, setKeys] = useState<KeyRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const previousApi = useRef(api);

  // biome-ignore lint/correctness/useExhaustiveDependencies: saving/deleting starts a fresh poll and invalidates the previous list request
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listed = false;
    let bootId: string | undefined;
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
        listed = false;
        setKeys([]);
        setLoadError(null);
      } else if (!listed || next.bootId !== bootId) {
        if (listed) setKeys([]);
        bootId = next.bootId;
        try {
          const list = await loadKeys(api);
          if (cancelled) return;
          setKeys(list);
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

  const save = useCallback(
    async (binding: SecretBinding, value: string) => {
      const { restart } = await saveKey(api, binding, value);
      setVersion((v) => v + 1);
      return { restart };
    },
    [api],
  );

  const remove = useCallback(
    async (id: string) => {
      await deleteKey(api, id);
      setVersion((v) => v + 1);
    },
    [api],
  );

  return { health, keys, loadError, save, remove };
}

import type { ProofReply } from "@localdot/protocol";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { loadProof } from "./api.ts";

export type ProofState =
  | { state: "loading" }
  | { state: "ready"; proof: ProofReply }
  | { state: "failed" };
// Every result of one task shares one request; a new result (refresh) asks again. Answers are kept
// per client, so a fresh client never sees another's answer.
interface Asked {
  pending: Promise<ProofReply>;
  // Once answered, a result drawn again shows its proof in its first frame.
  reply?: ProofReply;
}
const caches = new WeakMap<ApiClient, Map<string, Asked>>();
const cacheOf = (api: ApiClient) => {
  const cache = caches.get(api) ?? new Map<string, Asked>();
  caches.set(api, cache);
  return cache;
};
export function useProof(api: ApiClient, sessionId: string, refresh: number): ProofState {
  const key = `${sessionId}/${refresh}`;
  const [proof, setProof] = useState<{ key: string; state: ProofState }>(() => {
    const reply = cacheOf(api).get(key)?.reply;
    return { key, state: reply ? { state: "ready", proof: reply } : { state: "loading" } };
  });
  useEffect(() => {
    const cache = cacheOf(api);
    let asked = cache.get(key);
    if (!asked) {
      // Only the latest answer per task is kept, so a long conversation does not pile them up.
      for (const old of cache.keys()) if (old.startsWith(`${sessionId}/`)) cache.delete(old);
      const fresh: Asked = { pending: loadProof(api, sessionId) };
      fresh.pending.then(
        (reply) => {
          fresh.reply = reply;
        },
        () => cache.delete(key),
      );
      cache.set(key, fresh);
      asked = fresh;
    }
    let live = true;
    asked.pending.then(
      (reply) => {
        if (live) setProof({ key, state: { state: "ready", proof: reply } });
      },
      () => {
        if (live) setProof({ key, state: { state: "failed" } });
      },
    );
    return () => {
      live = false;
    };
  }, [api, sessionId, key]);
  // A newer result keeps showing the proof it had until the new answer arrives.
  return proof.state;
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ApiClient } from "../lib/api.ts";
import { loadKnowledge } from "./control-api.ts";

export const SkillsResponse = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      description: z
        .string()
        .min(1)
        .max(1024)
        .refine((value) => value.length <= 1024 && value.isWellFormed() && !value.includes("\0")),
      source: z.enum(["builtin", "user"]),
    }),
  )
  .max(100)
  .refine((rows) => new Set(rows.map((row) => row.name)).size === rows.length);
export const MemoryResponse = z.strictObject({
  user: z
    .string()
    .max(20_000)
    .refine((text) => text.isWellFormed() && !text.includes("\0")),
  memory: z
    .string()
    .max(20_000)
    .refine((text) => text.isWellFormed() && !text.includes("\0")),
});
type Phase = "unknown" | "loading" | "ready" | "error";
interface State {
  skills: z.infer<typeof SkillsResponse>;
  skillsPhase: Phase;
  memory: z.infer<typeof MemoryResponse> | null;
  memoryPhase: Phase;
}
const empty: State = { skills: [], skillsPhase: "unknown", memory: null, memoryPhase: "unknown" };
export function useKnowledge(api: ApiClient, sessionId: string | null, visible: boolean) {
  const [state, setState] = useState<State>(empty);
  const current = useRef({ api, sessionId, visible });
  const pending = useRef(new Map<"skills" | "memory", AbortController>());
  const mounted = useRef(true);
  const retire = useCallback(() => {
    const retiring = [...pending.current.entries()];
    pending.current.clear();
    for (const [, controller] of retiring) controller.abort();
    if (mounted.current && retiring.length)
      setState((old) => {
        const next = { ...old };
        for (const [kind] of retiring) {
          if (next[`${kind}Phase`] === "loading") next[`${kind}Phase`] = "unknown";
        }
        return next;
      });
  }, []);
  useLayoutEffect(() => {
    const old = current.current;
    current.current = { api, sessionId, visible };
    if (old.api !== api || old.sessionId !== sessionId || !visible) {
      retire();
      setState(empty);
    }
  }, [api, sessionId, visible, retire]);
  const read = useCallback(async (kind: "skills" | "memory") => {
    const owner = current.current;
    if (
      !mounted.current ||
      !owner.visible ||
      document.hidden ||
      !navigator.onLine ||
      pending.current.has(kind)
    )
      return;
    const controller = new AbortController();
    pending.current.set(kind, controller);
    setState((old) => ({ ...old, [`${kind}Phase`]: "loading" }));
    const owned = () =>
      mounted.current &&
      !controller.signal.aborted &&
      current.current.api === owner.api &&
      current.current.sessionId === owner.sessionId &&
      current.current.visible &&
      pending.current.get(kind) === controller;
    try {
      if (kind === "skills") {
        const skills = await loadKnowledge(
          owner.api,
          "/api/agent/skills",
          controller.signal,
          (value) => SkillsResponse.parse(value),
        );
        if (owned()) setState((old) => ({ ...old, skills, skillsPhase: "ready" }));
      } else {
        const memory = await loadKnowledge(
          owner.api,
          "/api/agent/memory",
          controller.signal,
          (value) => MemoryResponse.parse(value),
        );
        if (owned()) setState((old) => ({ ...old, memory, memoryPhase: "ready" }));
      }
    } catch {
      if (owned()) setState((old) => ({ ...old, [`${kind}Phase`]: "error" }));
    } finally {
      if (pending.current.get(kind) === controller) pending.current.delete(kind);
      controller.abort();
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.hidden) retire();
    };
    window.addEventListener("pagehide", retire);
    window.addEventListener("offline", retire);
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      retire();
      window.removeEventListener("pagehide", retire);
      window.removeEventListener("offline", retire);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [retire]);
  useEffect(() => {
    if (visible && current.current.api === api && current.current.sessionId === sessionId)
      void read("skills");
  }, [api, sessionId, visible, read]);
  return {
    ...state,
    reloadSkills: () => void read("skills"),
    rereadMemory: () => void read("memory"),
  };
}
export type Knowledge = ReturnType<typeof useKnowledge>;

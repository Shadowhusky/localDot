import {
  Routine,
  RoutineAppEvent,
  type RoutineConfirm,
  type RoutineDraft,
  RoutineListReply,
  RoutineRunsReply,
  type RoutineUpdate,
  StartAtLoginState,
  StopAllOutcome,
} from "@localdot/protocol";
import { z } from "zod";
import type { ApiClient } from "../lib/api.ts";
import { openSocket } from "../lib/socket.ts";

const LoginReply = z.object({ state: StartAtLoginState });
const Resumed = z.object({ resumed: z.number().int().nonnegative() });
const RunNow = z.object({ runId: z.string() });

export type RoutinesApi = ReturnType<typeof routinesApi>;

export function routinesApi(api: ApiClient) {
  const one = async (reply: Promise<unknown>) => Routine.parse(await reply);
  return {
    list: async (signal?: AbortSignal) =>
      RoutineListReply.parse(await api.get("/api/routines", signal ? { signal } : undefined)),
    get: (id: string) => one(api.get(`/api/routines/${id}`)),
    create: (draft: RoutineDraft) => one(api.post("/api/routines", draft)),
    update: (id: string, patch: RoutineUpdate) => one(api.put(`/api/routines/${id}`, patch)),
    remove: (id: string, revision: number) =>
      api.del(`/api/routines/${id}?revision=${encodeURIComponent(revision)}`),
    confirm: (id: string, body: RoutineConfirm) =>
      one(api.post(`/api/routines/${id}/confirm`, body)),
    runNow: async (id: string) => RunNow.parse(await api.post(`/api/routines/${id}/run`)),
    runs: async (id: string, before?: string) =>
      RoutineRunsReply.parse(
        await api.get(
          `/api/routines/${id}/runs${before ? `?before=${encodeURIComponent(before)}` : ""}`,
        ),
      ).runs,
    seen: (id: string) => api.post<void>(`/api/routines/${id}/seen`),
    resume: async () => Resumed.parse(await api.post("/api/routines/resume")),
    stopAll: async () => StopAllOutcome.parse(await api.post("/api/stop-all")),
    startAtLogin: async () => LoginReply.parse(await api.get("/api/start-at-login")).state,
    setStartAtLogin: async (enabled: boolean) =>
      LoginReply.parse(await api.put("/api/start-at-login", { enabled })).state,
  };
}

// Routine changes from every device and every run, as they happen.
export function subscribeRoutineEvents(
  api: ApiClient,
  onEvent: (event: RoutineAppEvent) => void,
  onOpen?: () => void,
): () => void {
  const socket = openSocket({
    url: api.socketUrl("/api/events"),
    protocols: api.socketProtocols(),
    handlers: {
      onOpen,
      onMessage: (data) => {
        try {
          const parsed = RoutineAppEvent.safeParse(JSON.parse(data));
          if (parsed.success) onEvent(parsed.data);
        } catch {
          // Not a routine event.
        }
      },
    },
  });
  return () => socket.close();
}

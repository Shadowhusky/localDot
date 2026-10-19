import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";

export type RuntimeProblem = "docker" | "recovering" | "failed";
export function useRuntime(api: ApiClient) {
  const [problem, setProblem] = useState<RuntimeProblem | null>(null);
  const [checked, setChecked] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const check = useCallback(() => refresh.current(), []);
  useEffect(() => {
    let closed = false,
      busy = false,
      waiting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = async () => {
      if (closed || busy || document.visibilityState === "hidden") return;
      busy = true;
      clearTimeout(timer);
      let again = waiting;
      try {
        const reply = await api.get<{ docker?: unknown; startup?: unknown }>("/api/runtime");
        if (closed) return;
        const next: RuntimeProblem | null =
          reply?.docker === "unavailable"
            ? "docker"
            : reply?.startup === "waiting" || reply?.startup === "recovering"
              ? "recovering"
              : reply?.startup === "failed"
                ? "failed"
                : null;
        setProblem(next);
        again = waiting = next === "docker" || next === "recovering";
      } catch {
        /* An older daemon or a disconnected page is not proof Docker is off. */
      } finally {
        busy = false;
        if (!closed) {
          setChecked(true);
          if (again) timer = setTimeout(() => void probe(), 5000);
        }
      }
    };
    refresh.current = () => void probe();
    void probe();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      closed = true;
      clearTimeout(timer);
      refresh.current = () => {};
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [api, check]);
  return { problem, checked, check };
}

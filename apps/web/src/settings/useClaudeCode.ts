import type { ClaudeCodeStatus } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { loadClaudeCode } from "./settings-api.ts";

// Coming back from Terminal looks again, at most this often.
const REFOCUS_MS = 5_000;

// The user's own Claude Code: read once when it matters, checked again on request and whenever the
// person comes back to this page while it isn't ready yet.
export function useClaudeCode(api: ApiClient, active: boolean) {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef<AbortController | null>(null);
  const last = useRef(0);
  const run = useCallback(
    async (fresh: boolean) => {
      flight.current?.abort();
      const abort = new AbortController();
      flight.current = abort;
      last.current = Date.now();
      setChecking(true);
      setError(null);
      try {
        const next = await loadClaudeCode(api, fresh, abort.signal);
        if (flight.current === abort) setStatus(next);
      } catch {
        if (flight.current === abort)
          setError("localDot couldn't check Claude Code. Check that localDot is running.");
      } finally {
        if (flight.current === abort) {
          flight.current = null;
          setChecking(false);
        }
      }
    },
    [api],
  );
  useEffect(() => {
    if (active && !status && !flight.current) void run(false);
  }, [active, status, run]);
  const ready = status?.state === "signed_in";
  useEffect(() => {
    if (!active || ready) return;
    const look = () => {
      if (document.visibilityState === "visible" && Date.now() - last.current >= REFOCUS_MS)
        void run(true);
    };
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => {
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [active, ready, run]);
  useEffect(() => () => flight.current?.abort(), []);
  return {
    status,
    checking,
    error,
    models: ready ? status.models : [],
    canStart: ready,
    check: () => run(true),
  };
}
export type ClaudeCodeControls = ReturnType<typeof useClaudeCode>;

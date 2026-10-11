import { ULID_PATTERN, ulid } from "@localdot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import type { FreshStartAction } from "../shell/Curtain.tsx";
import { DOCKER_DOWN } from "./errors.ts";
import type { CellSummary } from "./types.ts";

// Setting the old computer aside and starting a clean one can take a few minutes.
const RESET_WAIT_MS = 300_000;

export interface FreshStart {
  // Offered for this computer: it is there and nothing else is replacing it.
  available: boolean;
  busy: boolean;
  error: string | null;
  run(): void;
  // What the curtain offers: the way back from an update that can't be finished, and a fresh
  // start that is going on or didn't finish.
  curtain?: FreshStartAction;
}

const UNFINISHED = "Starting fresh didn't finish. Try again.";

export function describeFreshStartError(status: number | null): string {
  if (status === null) return "localDot isn't answering. Check that it's running.";
  if (status === 502) return `${DOCKER_DOWN}, then try again.`;
  return UNFINISHED;
}

// Erases the computer and starts a clean one in its place; sign-ins are kept. The daemon only
// takes the same request again once one has begun, so it is kept until the fresh computer is in.
export function useFreshStart(
  api: ApiClient,
  cell: CellSummary | null,
  selectReady: (id: string) => Promise<boolean>,
): FreshStart {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const id = cell?.id ?? null;
  const run = useCallback(() => {
    if (!id || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const requestId = savedRequest(id) ?? saveRequest(id, ulid());
    void requestReset(api, id, requestId)
      .then(async (fresh) => {
        if (await selectReady(fresh)) forgetRequest(id);
      })
      .catch((failure: unknown) => {
        const status = failure instanceof ResetFailure ? failure.status : null;
        if (mounted.current) setError(describeFreshStartError(status));
      })
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      });
  }, [api, id, selectReady]);
  // A lost reply or another tab can finish the same reset. Observe its durable
  // status without issuing another destructive request, and adopt it when ready.
  const recovering = !!cell?.fenced && !busy;
  useEffect(() => {
    const requestId = id && savedRequest(id);
    if (!id || !requestId || !recovering) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await api.fetch(
          `${api.socketUrl("").replace(/^ws/, "http")}/api/cells/${id}/reset/${requestId}`,
          {
            method: "GET",
            headers: { authorization: api.authorization() },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          },
        );
        if (response.status === 401) {
          api.rejectUnauthorized?.();
          return;
        }
        const record = response.ok ? await response.json() : null;
        if (
          !cancelled &&
          record?.phase === "ready" &&
          record.oldCellId === id &&
          record.requestId === requestId &&
          typeof record.newCellId === "string" &&
          ULID_PATTERN.test(record.newCellId)
        ) {
          if (await selectReady(record.newCellId)) {
            forgetRequest(id);
            if (!cancelled) setError(null);
            return;
          }
        }
      } catch {}
      if (!cancelled) timer = setTimeout(() => void check(), 3000);
    };
    void check();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, id, recovering, selectReady]);
  // A fresh start that began holds the old computer aside until the same request finishes it.
  const left = !!cell?.fenced && !busy && savedRequest(cell.id) !== undefined;
  return {
    available: busy || (!!cell && !cell.fenced && !cell.replacementPending && !cell.updating),
    busy,
    error,
    run,
    ...(cell?.needsFreshStart || busy || left
      ? { curtain: { busy, note: error ?? (left ? UNFINISHED : undefined), run } }
      : {}),
  };
}

class ResetFailure extends Error {
  constructor(readonly status: number | null) {
    super("reset failed");
  }
}

async function requestReset(api: ApiClient, id: string, requestId: string): Promise<string> {
  let response: Response;
  try {
    response = await api.fetch(
      `${api.socketUrl("").replace(/^ws/, "http")}/api/cells/${encodeURIComponent(id)}/reset`,
      {
        method: "POST",
        headers: { authorization: api.authorization(), "content-type": "application/json" },
        body: JSON.stringify({ requestId, eraseComputer: true }),
        signal: AbortSignal.timeout(RESET_WAIT_MS),
      },
    );
  } catch {
    throw new ResetFailure(null);
  }
  if (response.status === 401) api.rejectUnauthorized?.();
  if (!response.ok) throw new ResetFailure(response.status);
  const fresh = ((await response.json().catch(() => null)) as { newCellId?: unknown } | null)
    ?.newCellId;
  if (typeof fresh !== "string" || !ULID_PATTERN.test(fresh)) throw new ResetFailure(null);
  return fresh;
}

const requestKey = (id: string) => `localdot-fresh-start:${id}`;

function savedRequest(id: string): string | undefined {
  try {
    const saved = localStorage.getItem(requestKey(id));
    return saved && ULID_PATTERN.test(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

function saveRequest(id: string, requestId: string): string {
  try {
    localStorage.setItem(requestKey(id), requestId);
  } catch {}
  return requestId;
}

function forgetRequest(id: string): void {
  try {
    localStorage.removeItem(requestKey(id));
  } catch {}
}

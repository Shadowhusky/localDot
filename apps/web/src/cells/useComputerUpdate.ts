import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import { DOCKER_DOWN } from "./errors.ts";
import type { CellSummary } from "./types.ts";

// Stopping, renewing and starting the computer can outlast the client's usual 15 s wait.
const UPDATE_WAIT_MS = 180_000;
const FAILED = "computer-update-failed";
const READY = "computer-update-ready";
export const UPDATE_READY = "A new version of your computer is ready";

// The daemon's own answers that are already plain words (apps/daemon/src/cells/computer-update.ts
// and orchestrator.ts); anything else stays out of sight.
const PLAIN = new Set([
  "The previous system image is missing from Docker. Restore it before updating this computer. Your apps and files are unchanged.",
  "An installed app changed files needed by this update. Nothing was replaced.",
  "This computer has installed apps or system changes that this update cannot preserve yet. Your computer is unchanged; you can keep using it. Updating localDot itself is separate.",
  "This computer can't be updated right now.",
  "Your computer is already updating.",
  "Your computer is up to date.",
  "Wait for dot to finish, or stop the task first.",
  "Hand back the computer first.",
  "Your computer couldn't be updated. It's back as it was.",
  "Your computer couldn't be updated. Turn it on to keep using it.",
  "The update didn't finish. Turn on your computer to finish it.",
  "localDot can't read its update records. Restart localDot, then turn on your computer.",
  "The new version isn't on this Mac yet.",
  "This computer is too old to update.",
  "The key layer didn't answer. Try again in a moment.",
]);

export function describeUpdateError(status: number | null, text: string): string {
  if (status === null) return "localDot isn't answering. Check that it's running.";
  if (status === 409 && PLAIN.has(text)) return text;
  if (status === 502) return `${DOCKER_DOWN}, then try again.`;
  return "Your computer couldn't be updated. Try again.";
}

export interface ComputerUpdate {
  // A new version is ready, or going on now.
  available: boolean;
  busy: boolean;
  error: string | null;
  // Why Update has to wait: dot is at work, or the user holds the computer.
  waitReason?: string;
  run(): void;
}

export function useComputerUpdate(api: ApiClient, cell: CellSummary | null): ComputerUpdate {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useRef(cell);
  current.current = cell;
  const id = cell?.id ?? null;
  const run = useCallback(() => {
    if (!id || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    dismissToast(READY);
    dismissToast(FAILED);
    void requestUpdate(api, id)
      .catch((failure: unknown) => {
        const { status, text } =
          failure instanceof UpdateFailure ? failure : { status: null, text: "" };
        if (
          (status === null || status === 504 || status === 524) &&
          current.current?.id === id &&
          current.current.updating
        ) {
          showToast({
            id: READY,
            title: "Your computer is still updating. Progress will appear here when it finishes.",
          });
          return;
        }
        const message = describeUpdateError(status, text);
        showToast({ id: FAILED, title: message, tone: "danger" });
        if (mounted.current) setError(message);
      })
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSending(false);
      });
  }, [api, id]);
  const updating = !!cell?.updating;
  return {
    available: !!cell?.updateAvailable || updating || sending,
    busy: sending || updating,
    error,
    run,
  };
}

class UpdateFailure extends Error {
  constructor(
    readonly status: number | null,
    readonly text: string,
  ) {
    super("update failed");
  }
}

async function requestUpdate(api: ApiClient, id: string): Promise<void> {
  let response: Response;
  try {
    response = await api.fetch(
      `${api.socketUrl("").replace(/^ws/, "http")}/api/cells/${encodeURIComponent(id)}/update`,
      {
        method: "POST",
        headers: { authorization: api.authorization() },
        signal: AbortSignal.timeout(UPDATE_WAIT_MS),
      },
    );
  } catch {
    throw new UpdateFailure(null, "");
  }
  if (response.status === 401) api.rejectUnauthorized?.();
  if (!response.ok) throw new UpdateFailure(response.status, await response.text().catch(() => ""));
}

const noticeKey = (id: string) => `localdot-update-notice:${id}`;

function noticed(id: string): boolean {
  try {
    return localStorage.getItem(noticeKey(id)) !== null;
  } catch {
    return false;
  }
}

function notice(id: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(noticeKey(id), "1");
    else localStorage.removeItem(noticeKey(id));
  } catch {}
}

// Says once, quietly from the island, that a new version is ready, and only while dot is not at
// work. It can say so again after the computer has been brought up to date.
export function useUpdateNotice(cell: CellSummary | null, idle: boolean, update: ComputerUpdate) {
  const run = useRef(update.run);
  run.current = update.run;
  const id = cell?.id ?? null;
  const ready = !!cell?.updateAvailable && !update.busy;
  const current = cell?.state === "ready" && !cell.updateAvailable && !update.busy;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    if (current) {
      notice(id, false);
      shown.current = null;
    }
    if (!ready || !idle) {
      dismissToast(READY);
      return;
    }
    if (shown.current === id || noticed(id)) return;
    shown.current = id;
    notice(id, true);
    showToast({
      id: READY,
      title: UPDATE_READY,
      action: { label: "Update", onAction: () => run.current() },
    });
  }, [id, ready, current, idle]);
}

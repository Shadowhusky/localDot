import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ComputerUpdateFailure,
  ComputerUpdateStage,
} from "../../../../packages/protocol/src/computer-operation.ts";
import type { ApiClient } from "../lib/api.ts";
import { dismissToast, showToast } from "../ui/Toast.tsx";
import { stageBounds, stageLine, waitNote } from "./computer-update-stage.ts";
import { DOCKER_DOWN } from "./errors.ts";
import type { CellSummary } from "./types.ts";

// Stopping, renewing and starting the computer can outlast the client's usual 15 s wait. Past this
// the page stops waiting for its request, and reads how it went from the computer's summary.
const UPDATE_WAIT_MS = 180_000;
const FAILED = "computer-update-failed";
const READY = "computer-update-ready";
const GOING = "computer-update-going";
const DONE = "computer-update-done";
export const UPDATE_READY = "A new version of your computer is ready";
export const UPDATE_BLOCKED =
  "An installed app changed files this update needs, so it can't be applied automatically. Your computer is unchanged; you can keep using it. To get the new version, Start fresh in Settings; it erases your computer's files.";

// The daemon's own answers that are already plain words (apps/daemon/src/cells/computer-update.ts
// and orchestrator.ts); anything else stays out of sight.
const PLAIN = new Set([
  "The previous system image is missing from Docker. Restore it before updating this computer. Your apps and files are unchanged.",
  UPDATE_BLOCKED,
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
  // There is a new version that Update can still put on.
  offered?: boolean;
  busy: boolean;
  error: string | null;
  // Why Update has to wait: dot is at work, or the user holds the computer.
  waitReason?: string;
  run(): void;
  // The stage under way, what it is doing, and how far the whole update has got.
  stage?: ComputerUpdateStage | null;
  line?: string | null;
  value?: number | null;
  // How long it is taking, when that is worth saying.
  note?: string | null;
  failure?: ComputerUpdateFailure | null;
}

// A daemon's answer to an update that had begun; the computer's summary says the same, with why.
const AFTER_IT_BEGAN = new Set([
  "Your computer couldn't be updated. It's back as it was.",
  "Your computer couldn't be updated. Turn it on to keep using it.",
  "The update didn't finish. Turn on your computer to finish it.",
  "The new version couldn't be downloaded. Your computer is still running, and your files are kept.",
  "Your computer is already updating.",
]);

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
        const { status, text, timedOut } =
          failure instanceof UpdateFailure ? failure : { status: null, text: "", timedOut: false };
        // The daemon carries on without this request, and its summary says how it goes.
        if (
          timedOut ||
          ((status === null || status === 504 || status === 524) && current.current?.updating) ||
          (status === 409 && AFTER_IT_BEGAN.has(text))
        )
          return;
        const message = describeUpdateError(status, text);
        // The computer now says its update is blocked, and the notice says so once.
        if (message !== UPDATE_BLOCKED) showToast({ id: FAILED, title: message, tone: "danger" });
        if (mounted.current) setError(message);
      })
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSending(false);
      });
  }, [api, id]);
  const updating = !!cell?.updating;
  const progress = cell?.updateProgress;
  const going = updating || sending || !!progress;
  const stage = progress?.stage ?? (going ? "download" : null);
  const failure = going ? null : (cell?.updateFailure ?? null);
  const operation = cell?.operation?.kind === "update" ? cell.operation : null;
  const since = useRef<{ at: number; startedAt: number } | null>(null);
  if (operation && since.current?.startedAt !== operation.startedAt)
    since.current = { at: Date.now() - operation.elapsedMs, startedAt: operation.startedAt };
  if (!operation) since.current = null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!going) return;
    const timer = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(timer);
  }, [going]);
  return {
    available: !!cell?.updateAvailable || going,
    offered: !!cell?.updateAvailable,
    busy: going,
    error,
    run,
    stage,
    line: stage ? stageLine(stage, progress?.detail) : null,
    value:
      !stage || (stage === "download" && progress?.share === undefined)
        ? null
        : stageBounds(stage, progress?.share)[0],
    note:
      operation && since.current
        ? waitNote(Date.now() - since.current.at, operation.expectedMs)
        : null,
    failure,
  };
}

class UpdateFailure extends Error {
  constructor(
    readonly status: number | null,
    readonly text: string,
    readonly timedOut = false,
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
  } catch (error) {
    throw new UpdateFailure(null, "", error instanceof Error && error.name === "TimeoutError");
  }
  if (response.status === 401) api.rejectUnauthorized?.();
  if (!response.ok) throw new UpdateFailure(response.status, await response.text().catch(() => ""));
}

const noticeKey = (id: string) => `localdot-update-notice:${id}`;

// What the notice last said about a computer: "1" that a new version is ready, or "blocked".
type Said = "1" | "blocked";

function noticed(id: string): string | null {
  try {
    return localStorage.getItem(noticeKey(id));
  } catch {
    return null;
  }
}

function notice(id: string, said: Said | null): void {
  try {
    if (said) localStorage.setItem(noticeKey(id), said);
    else localStorage.removeItem(noticeKey(id));
  } catch {}
}

const failureKey = (id: string) => `localdot-update-failure:${id}`;
function saidFailure(id: string, failure: ComputerUpdateFailure) {
  const said = `${failure.at} ${failure.message}`;
  try {
    if (localStorage.getItem(failureKey(id)) === said) return true;
    localStorage.setItem(failureKey(id), said);
  } catch {}
  return false;
}

// A toast keeps its element while its words stay the same, so its live line follows by itself.
let goingLine = "";
const goingListeners = new Set<() => void>();
function setGoingLine(line: string) {
  goingLine = line;
  for (const listener of goingListeners) listener();
}
function GoingLine() {
  const line = useSyncExternalStore(
    (listener) => {
      goingListeners.add(listener);
      return () => goingListeners.delete(listener);
    },
    () => goingLine,
  );
  return `Updating your computer · ${line}`;
}

// While the computer updates, every device says so wherever it is looking, and when it ends, how.
export function useUpdateProgressNotice(
  cell: CellSummary | null,
  update: ComputerUpdate,
  details: () => void,
) {
  const detailsRef = useRef(details);
  detailsRef.current = details;
  const run = useRef(update.run);
  run.current = update.run;
  const going = !!update.stage;
  const watched = useRef(false);
  useEffect(() => {
    if (update.line) setGoingLine(update.line);
  }, [update.line]);
  useEffect(() => {
    if (!going) {
      dismissToast(GOING);
      return;
    }
    dismissToast(DONE);
    showToast({
      id: GOING,
      title: "Updating your computer",
      live: createElement(GoingLine),
      action: { label: "Details", onAction: () => detailsRef.current() },
    });
  }, [going]);
  // Only what the daemon took on can end in "updated": a refused press never began.
  if (cell?.updating) watched.current = true;
  const id = cell?.id ?? null;
  const failure = update.failure;
  const offered = !!update.offered;
  useEffect(() => {
    if (!id || !failure || saidFailure(id, failure)) return;
    watched.current = false;
    showToast({
      id: FAILED,
      title: "Your computer wasn't updated",
      description: failure.message,
      tone: "danger",
      ...(offered && {
        action: {
          label: "Retry",
          onAction: () => {
            dismissToast(FAILED);
            run.current();
          },
        },
      }),
    });
  }, [id, failure, offered]);
  const settled = !going && !failure && !offered && cell?.state === "ready";
  useEffect(() => {
    if (!settled || !watched.current) return;
    watched.current = false;
    showToast({
      id: DONE,
      title: "Your computer is updated",
      description: "Your files and sign-ins are all still there.",
    });
  }, [settled]);
}

// Says once, quietly from the island, that a new version is ready, or that it can't be applied,
// and only while dot is not at work. It can say so again after the computer has been brought up
// to date.
export function useUpdateNotice(cell: CellSummary | null, idle: boolean, update: ComputerUpdate) {
  const run = useRef(update.run);
  run.current = update.run;
  const id = cell?.id ?? null;
  const said: Said | null = update.busy
    ? null
    : cell?.updateAvailable
      ? "1"
      : cell?.updateBlocked
        ? "blocked"
        : null;
  const current =
    cell?.state === "ready" && !cell.updateAvailable && !cell.updateBlocked && !update.busy;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return;
    if (current) {
      notice(id, null);
      shown.current = null;
    }
    if (!said || !idle) {
      dismissToast(READY);
      return;
    }
    if (shown.current === `${id} ${said}` || noticed(id) === said) return;
    shown.current = `${id} ${said}`;
    notice(id, said);
    showToast(
      said === "1"
        ? {
            id: READY,
            title: UPDATE_READY,
            action: { label: "Update", onAction: () => run.current() },
          }
        : { id: READY, title: UPDATE_BLOCKED },
    );
  }, [id, said, current, idle]);
}

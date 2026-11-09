import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type AppUpdatePreferences,
  AppUpdateStatus,
  compareReleaseVersions,
} from "../../../../packages/protocol/src/app-update.ts";
import { RELEASE_VERSION } from "../../../../packages/protocol/src/release.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { dismissToast, showToast } from "../ui/Toast.tsx";

export type UpdateWait = "normal" | "slow" | "lost";
export interface AppUpdateControl {
  status: AppUpdateStatus | null;
  error: string | null;
  busy: boolean;
  // Update now was pressed and the daemon hasn't answered yet.
  starting: boolean;
  // Installing, and localDot has stopped answering while it restarts.
  restarting: boolean;
  // It answers again as the new version, which the installer is still checking.
  reconnecting: boolean;
  // How long the restart has been going, against how long one takes.
  wait: UpdateWait;
  check(): void;
  update(): void;
  preferences(value: AppUpdatePreferences): void;
}
const NOTICE = "app-update-ready";
const UPDATED = "app-updated";
const GOING = "app-update-going";
const FAILED = "app-update-failed";
// The version this browser last saw running, so it can say once that localDot was updated.
const SEEN_VERSION = "localdot.app-version";
// The update under way: what the service worker's page tells someone who reloads during the
// restart, and what tells the page it comes back to that it was watching.
const UNDERWAY = "localdot.app-update";
// A restart past these has gone wrong, or has at least stopped being normal.
const SLOW_MS = 90_000;
const LOST_MS = 5 * 60_000;
const CLOSE_POLL_MS = 2_000;
const IDLE_POLL_MS = 20_000;
const shown = (version: string) => (version.length === 40 ? version.slice(0, 8) : version);
function seenVersion(current: string): string | null {
  try {
    const seen = localStorage.getItem(SEEN_VERSION);
    localStorage.setItem(SEEN_VERSION, current);
    return seen;
  } catch {
    return null;
  }
}
function remember(version: string | null) {
  try {
    if (version) localStorage.setItem(UNDERWAY, version);
    else localStorage.removeItem(UNDERWAY);
  } catch {}
}
function remembered() {
  try {
    return localStorage.getItem(UNDERWAY);
  } catch {
    return null;
  }
}
// A step back is a rollback, which the daemon explains. Source builds are named by commit.
function wentBack(seen: string, current: string) {
  return (
    RELEASE_VERSION.test(seen) &&
    RELEASE_VERSION.test(current) &&
    compareReleaseVersions(current, seen) < 0
  );
}
// Lets a reload during the restart find a page that waits, instead of the browser's own error.
function registerWaitingPage() {
  void navigator.serviceWorker?.register("/sw.js", { scope: "/" }).catch(() => {});
}
const active = (status: AppUpdateStatus | null) =>
  status?.phase === "checking" || status?.phase === "downloading" || status?.phase === "installing";

function liveLine(status: AppUpdateStatus) {
  if (status.phase === "checking") return "Checking for updates…";
  return status.progress?.detail ?? "Working on it…";
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
  return `Updating localDot · ${line}`;
}

export function useAppUpdate(api: ApiClient, idle: boolean, review: () => void): AppUpdateControl {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  // Why the last request was refused, and that the daemon isn't there to ask.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [wait, setWait] = useState<UpdateWait>("normal");
  const installing = useRef(false);
  const asked = useRef(false);
  const lostAt = useRef<number | null>(null);
  const installedVersion = useRef<string | null>(null);
  const latest = useRef<AppUpdateStatus | null>(null);
  const mounted = useRef(true),
    pending = useRef(false),
    unavailable = useRef(false);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const refresh = useCallback(async () => {
    if (unavailable.current) return;
    // A page following an update closely keeps its copy of the notes.
    const lean = active(latest.current);
    try {
      const answer = AppUpdateStatus.parse(
        await api.get(lean ? "/api/app-update?v=2&notes=0" : "/api/app-update?v=2"),
      );
      const result = lean ? { ...answer, notes: latest.current?.notes ?? [] } : answer;
      if (mounted.current) {
        if (
          result.supported &&
          result.phase !== "installing" &&
          installedVersion.current &&
          installedVersion.current !== result.currentVersion
        ) {
          // Showing this status would poll again, and the reload would cut that request off.
          window.location.reload();
          return;
        }
        if (result.supported) installedVersion.current ??= result.currentVersion;
        installing.current = result.phase === "installing";
        if (installing.current) {
          registerWaitingPage();
          remember(result.availableVersion ?? result.currentVersion);
        }
        lostAt.current = null;
        setWait("normal");
        setRestarting(false);
        latest.current = result;
        setStatus(result);
        setUnreachable(false);
        if (result.updating || result.phase === "installing") setRefusal(null);
      }
    } catch (err) {
      if (!mounted.current) return;
      // Older daemons and QA servers can serve the updated UI before their backend is restarted.
      if (err instanceof ApiError && err.status === 404 && !installing.current && !asked.current) {
        unavailable.current = true;
        return;
      }
      if (err instanceof ApiError && err.status === 401) return;
      // Installing stops localDot; it answers again once the new version has started.
      if (installing.current || asked.current) {
        lostAt.current ??= Date.now();
        setRestarting(true);
        const gone = Date.now() - lostAt.current;
        setWait(gone >= LOST_MS ? "lost" : gone >= SLOW_MS ? "slow" : "normal");
      } else setUnreachable(true);
    }
  }, [api]);
  const closely = active(status) || restarting || starting;
  useEffect(() => {
    mounted.current = true;
    unavailable.current = false;
    void refresh();
    const wake = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(wake, closely ? CLOSE_POLL_MS : IDLE_POLL_MS);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh, closely]);
  const act = useCallback(
    (work: () => Promise<unknown>, refused: (err: ApiError) => string, settled = () => {}) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setRefusal(null);
      void work()
        .then(refresh)
        .catch((err: unknown) => {
          if (!mounted.current) return;
          if (err instanceof ApiError) {
            asked.current = false;
            setRefusal(refused(err));
            return;
          }
          // No answer at all: the daemon may have just stopped for this very update.
          return refresh();
        })
        .finally(() => {
          pending.current = false;
          if (mounted.current) {
            setBusy(false);
            settled();
          }
        });
    },
    [refresh],
  );
  const update = useCallback(() => {
    if (pending.current) return;
    asked.current = true;
    setStarting(true);
    registerWaitingPage();
    act(
      () => api.post("/api/app-update/update", { confirmShutdown: true }),
      // The daemon's own plain words, such as why a working task holds the update back.
      (err) =>
        err.status === 409 ? err.message : "The update couldn't start. Try again in a moment.",
      () => setStarting(false),
    );
  }, [act, api]);
  // Once the daemon carries the update, it is the one to ask.
  useEffect(() => {
    if (status && !status.updating && status.phase !== "installing" && !busy) asked.current = false;
    if (status && !status.updating && status.phase !== "installing") remember(null);
  }, [status, busy]);
  const announced = useRef(false);
  useEffect(() => {
    if (!status?.supported || announced.current || status.phase === "installing") return;
    announced.current = true;
    const seen = seenVersion(status.currentVersion);
    if (!seen || seen === status.currentVersion || wentBack(seen, status.currentVersion)) return;
    const notes = !status.availableVersion && status.notes.length > 0;
    showToast({
      id: UPDATED,
      title: `Updated to ${shown(status.currentVersion)}`,
      ...(notes && {
        action: {
          label: "What's new",
          onAction: () => {
            dismissToast(UPDATED);
            reviewRef.current();
          },
        },
      }),
    });
  }, [status]);
  const noticed = useRef<string | null>(null);
  useEffect(() => {
    const version = status?.availableVersion;
    if (
      !idle ||
      !version ||
      status?.updating ||
      status?.phase === "downloading" ||
      status?.phase === "checking"
    ) {
      dismissToast(NOTICE);
      return;
    }
    if (noticed.current === version || status.dismissedVersion === version) return;
    noticed.current = version;
    showToast({
      id: NOTICE,
      title: `localDot ${shown(version)} is available`,
      action: {
        label: "Review update",
        onAction: () => {
          dismissToast(NOTICE);
          reviewRef.current();
        },
      },
    });
    // Remember the notice per installation, across browsers. Settings retains the update.
    void api.post("/api/app-update/dismiss").catch(() => {});
  }, [api, idle, status]);
  // While the update someone asked for downloads, every device says so wherever it is looking,
  // and when it stops, says why and offers it again. A quiet background download stays quiet.
  const watched = useRef(!!remembered());
  const said = useRef<string | null>(null);
  const line = status ? liveLine(status) : "";
  const going =
    !!status?.updating && (status.phase === "checking" || status.phase === "downloading");
  useEffect(() => setGoingLine(line), [line]);
  useEffect(() => {
    if (going) watched.current = true;
    if (!going) {
      dismissToast(GOING);
      return;
    }
    showToast({
      id: GOING,
      title: "Updating localDot",
      live: createElement(GoingLine),
      action: {
        label: "Details",
        onAction: () => reviewRef.current(),
      },
    });
  }, [going]);
  const failure = status?.progress && !active(status) ? status.error : null;
  useEffect(() => {
    if (status?.phase === "installing" || restarting) watched.current = true;
    if (!failure) {
      said.current = null;
      return;
    }
    if (!watched.current || said.current === failure) return;
    said.current = failure;
    watched.current = false;
    showToast({
      id: FAILED,
      title: "The update didn't finish",
      description: failure,
      tone: "danger",
      action: {
        label: "Retry",
        onAction: () => {
          dismissToast(FAILED);
          update();
        },
      },
    });
  }, [failure, restarting, status?.phase, update]);
  return {
    status,
    error:
      refusal ??
      (unreachable ? "localDot isn't answering right now. This page reconnects by itself." : null),
    busy,
    starting,
    restarting,
    reconnecting:
      !restarting &&
      status?.phase === "installing" &&
      !!installedVersion.current &&
      installedVersion.current !== status.currentVersion,
    wait,
    check: () =>
      act(
        () => api.post("/api/app-update/check"),
        () => "That didn't work. Try again.",
      ),
    update,
    preferences: (value) =>
      act(
        () => api.put("/api/app-update/preferences", value),
        () => "That didn't work. Try again.",
      ),
  };
}

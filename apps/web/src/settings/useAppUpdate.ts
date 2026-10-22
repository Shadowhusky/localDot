import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AppUpdatePreferences,
  AppUpdateStatus,
} from "../../../../packages/protocol/src/app-update.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { dismissToast, showToast } from "../ui/Toast.tsx";

export interface AppUpdateControl {
  status: AppUpdateStatus | null;
  error: string | null;
  busy: boolean;
  // Installing, and localDot has stopped answering while it restarts.
  restarting: boolean;
  check(): void;
  download(): void;
  install(): void;
  preferences(value: AppUpdatePreferences): void;
}
const NOTICE = "app-update-ready";
const UPDATED = "app-updated";
// The version this browser last saw running, so it can say once that localDot was updated.
const SEEN_VERSION = "localdot.app-version";
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
export function useAppUpdate(api: ApiClient, idle: boolean, review: () => void): AppUpdateControl {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const installing = useRef(false);
  const installedVersion = useRef<string | null>(null);
  const mounted = useRef(true),
    pending = useRef(false),
    unavailable = useRef(false);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const refresh = useCallback(async () => {
    if (unavailable.current) return;
    try {
      const result = AppUpdateStatus.parse(await api.get("/api/app-update?v=2"));
      if (mounted.current) {
        if (
          result.supported &&
          installedVersion.current &&
          installedVersion.current !== result.currentVersion
        ) {
          // Showing this status would poll again, and the reload would cut that request off.
          window.location.reload();
          return;
        }
        if (result.supported) installedVersion.current = result.currentVersion;
        installing.current = result.phase === "installing";
        setRestarting(false);
        setStatus(result);
        setError(null);
      }
    } catch (err) {
      // Older daemons and QA servers can serve the updated UI before their backend is restarted.
      if (err instanceof ApiError && err.status === 404) unavailable.current = true;
      // Installing stops localDot; it answers again once the new version has started.
      else if (installing.current) {
        if (mounted.current) setRestarting(true);
      } else if (mounted.current) setError("Update status is unavailable. Try again.");
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    unavailable.current = false;
    void refresh();
    const wake = () => {
      if (!document.hidden) void refresh();
    };
    const timer = setInterval(wake, status?.phase && status.phase !== "idle" ? 5_000 : 60_000);
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
  }, [refresh, status?.phase]);
  const act = useCallback(
    (work: () => Promise<unknown>) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError(null);
      void work()
        .then(refresh)
        .catch(() => {
          if (mounted.current) setError("That update action couldn't complete. Try again.");
        })
        .finally(() => {
          pending.current = false;
          if (mounted.current) setBusy(false);
        });
    },
    [refresh],
  );
  const announced = useRef(false);
  useEffect(() => {
    if (!status?.supported || announced.current) return;
    announced.current = true;
    const seen = seenVersion(status.currentVersion);
    if (!seen || seen === status.currentVersion) return;
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
    if (!idle || !version || status?.phase === "downloading" || status?.phase === "checking") {
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
  return {
    status,
    error,
    busy,
    restarting,
    check: () => act(() => api.post("/api/app-update/check")),
    install: () => act(() => api.post("/api/app-update/install", { confirmShutdown: true })),
    download: () => act(() => api.post("/api/app-update/download")),
    preferences: (value) => act(() => api.put("/api/app-update/preferences", value)),
  };
}

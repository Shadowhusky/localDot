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
  check(): void;
  download(): void;
  install(): void;
  preferences(value: AppUpdatePreferences): void;
}
const NOTICE = "app-update-ready";
export function useAppUpdate(api: ApiClient, idle: boolean, review: () => void): AppUpdateControl {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const installedVersion = useRef<string | null>(null);
  const mounted = useRef(true),
    pending = useRef(false),
    unavailable = useRef(false);
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const refresh = useCallback(async () => {
    if (unavailable.current) return;
    try {
      const result = AppUpdateStatus.parse(await api.get("/api/app-update"));
      if (mounted.current) {
        if (
          result.supported &&
          installedVersion.current &&
          installedVersion.current !== result.currentVersion
        )
          window.location.reload();
        if (result.supported) installedVersion.current = result.currentVersion;
        setStatus(result);
        setError(null);
      }
    } catch (err) {
      // Older daemons and QA servers can serve the updated UI before their backend is restarted.
      if (err instanceof ApiError && err.status === 404) unavailable.current = true;
      else if (mounted.current) setError("Update status is unavailable. Try again.");
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
      title: `localDot ${version.length === 40 ? version.slice(0, 8) : version} is available`,
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
    check: () => act(() => api.post("/api/app-update/check")),
    install: () => act(() => api.post("/api/app-update/install", { confirmShutdown: true })),
    download: () => act(() => api.post("/api/app-update/download")),
    preferences: (value) => act(() => api.put("/api/app-update/preferences", value)),
  };
}

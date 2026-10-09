import type { BannerKind, NotifySettings, PushDevice } from "@localdot/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import {
  copyHomeScreenLink,
  type LinkClipboard,
  LinkNotCopied,
} from "../notify/home-screen-link.ts";
import { notifyApi } from "../notify/notify-api.ts";
import {
  browserEnv,
  type DeviceEnv,
  type DeviceState,
  deviceLabel,
  deviceState,
  turnOffThisDevice,
  turnOnThisDevice,
} from "../notify/this-device.ts";
import { announce } from "../ui/Announcer.tsx";
import { showToast } from "../ui/Toast.tsx";
import type { ToastOptions } from "../ui/toasts.ts";
import { errorLine, testResultLine } from "./notifications-copy.ts";

export interface NotificationsView {
  settings: NotifySettings | null;
  // How the computer running localDot shows banners: a Mac, a Linux desktop, or none at all.
  banner: BannerKind;
  // The saved settings or the phones could not be read; retry() reads them again.
  failed: boolean;
  devices: PushDevice[];
  device: DeviceState | null;
  // What this device is called in its row: "This Mac", "This iPhone".
  name: string;
  // This browser's own notification permission: on this Mac it lets a hidden tab show the
  // notification itself, so a click opens the task (the Mac banner cannot).
  tab: NotificationPermission | "unsupported";
  busy: "device" | "test" | "link" | "tab" | null;
  removing: string | null;
  // What the last test reached, in one plain line.
  result: { line: string; failed: boolean } | null;
  // A sign-in link the clipboard refused, to copy by hand until it expires.
  link: string | null;
  save(next: NotifySettings): void;
  retry(): void;
  turnOn(): void;
  turnOff(): void;
  remove(id: string): void;
  test(): void;
  copyLink(): void;
  allowTab(): void;
}

export interface NotificationsOptions {
  env?: DeviceEnv;
  clipboard?: LinkClipboard;
  toast?(options: ToastOptions): void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ANNOUNCE = "notifications";

// Settings › Notifications, read afresh each time Settings opens. Every change saves at once; a
// failed save puts the control back and says why.
export function useNotifications(
  api: ApiClient,
  active: boolean,
  opts: NotificationsOptions = {},
): NotificationsView {
  const notify = useMemo(() => notifyApi(api), [api]);
  const envRef = useRef<DeviceEnv | null>(opts.env ?? null);
  const env = useCallback(() => {
    envRef.current ??= browserEnv();
    return envRef.current;
  }, []);
  const toast = useRef(opts.toast ?? showToast);
  toast.current = opts.toast ?? showToast;
  const [settings, setSettings] = useState<NotifySettings | null>(null);
  const [banner, setBanner] = useState<BannerKind>("mac");
  const [failed, setFailed] = useState(false);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [tab, setTab] = useState<NotificationsView["tab"]>(
    () => env().notification?.permission() ?? "unsupported",
  );
  const [busy, setBusy] = useState<NotificationsView["busy"]>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [result, setResult] = useState<NotificationsView["result"]>(null);
  const [link, setLink] = useState<{ text: string; expiresAt: number } | null>(null);
  const [reads, setReads] = useState(0);
  const saving = useRef(0);

  const fail = useCallback((failure: unknown) => {
    toast.current({ title: errorLine(failure), tone: "danger" });
  }, []);

  const refresh = useCallback(async () => {
    const list = await notify.devices();
    setDevices(list);
    setDevice(
      await deviceState(
        list.map((row) => row.id),
        env(),
      ),
    );
  }, [notify, env]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry reads everything again
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // An older daemon has no host route; it ran on a Mac.
    const host = notify.host().catch((): BannerKind => "mac");
    Promise.all([notify.settings(), host, refresh()]).then(
      ([loaded, kind]) => {
        if (cancelled) return;
        setBanner(kind);
        setSettings(loaded);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    setTab(env().notification?.permission() ?? "unsupported");
    return () => {
      cancelled = true;
    };
  }, [active, notify, refresh, env, reads]);

  useEffect(() => {
    if (!link) return;
    const timer = setTimeout(() => setLink(null), Math.max(0, link.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [link]);

  const run = (kind: NonNullable<NotificationsView["busy"]>, work: () => Promise<void>) => {
    setBusy(kind);
    work()
      .catch(fail)
      .finally(() => setBusy(null));
  };

  const label = deviceLabel(env().userAgent, env().maxTouchPoints);
  return {
    settings,
    banner,
    failed,
    devices,
    device,
    name: LOOPBACK.has(env().hostname)
      ? banner === "mac"
        ? "This Mac"
        : "This computer"
      : label === "This device"
        ? label
        : `This ${label}`,
    tab,
    busy,
    removing,
    result,
    link: link?.text ?? null,
    save(next) {
      const before = settings;
      const mine = ++saving.current;
      setSettings(next);
      notify.saveSettings(next).then(
        (saved) => {
          if (mine === saving.current) setSettings(saved);
        },
        (failure) => {
          if (mine !== saving.current) return;
          setSettings(before);
          fail(failure);
        },
      );
    },
    retry: () => setReads((count) => count + 1),
    // Straight from the click: iOS asks for permission only inside the user's gesture.
    turnOn: () =>
      run("device", async () => {
        setDevice(await turnOnThisDevice(notify, env()));
        await refresh();
      }),
    turnOff: () =>
      run("device", async () => {
        setDevice(await turnOffThisDevice(notify, env()));
        await refresh();
      }),
    remove: (id) => {
      setRemoving(id);
      notify
        .removeDevice(id)
        .then(refresh)
        .catch(fail)
        .finally(() => setRemoving(null));
    },
    test: () =>
      run("test", async () => {
        setResult(null);
        try {
          const line = testResultLine(await notify.test(), banner);
          setResult({ line, failed: false });
          announce(ANNOUNCE, line);
        } catch (failure) {
          const line = errorLine(failure);
          setResult({ line, failed: true });
          announce(ANNOUNCE, line);
        }
      }),
    // Straight from the click, like Turn on.
    allowTab: () =>
      run("tab", async () => {
        setTab((await env().notification?.request()) ?? "unsupported");
      }),
    // Straight from the click: Safari copies only within the tap.
    copyLink: () =>
      run("link", async () => {
        setLink(null);
        try {
          await copyHomeScreenLink(api, opts.clipboard ?? navigator.clipboard);
        } catch (failure) {
          if (!(failure instanceof LinkNotCopied)) throw failure;
          setLink({ text: failure.link, expiresAt: failure.expiresAt });
          return;
        }
        toast.current({
          title: "Sign-in link copied",
          description: "Paste it in the Home Screen app within a minute. It works once.",
          tone: "success",
        });
      }),
  };
}

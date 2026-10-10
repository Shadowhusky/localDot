import type { PushSubscriptionInput } from "@localdot/protocol";
import { ApiError } from "../lib/api.ts";
import type { NotifyApi } from "./notify-api.ts";

// What "This device" can do in Settings › Notifications, in the order the checks run.
export type DeviceState =
  | { kind: "this-mac" }
  | { kind: "needs-https" }
  | { kind: "needs-home-screen" }
  | { kind: "unsupported" }
  | { kind: "blocked" }
  | { kind: "off" }
  | { kind: "on"; id: string };

export interface DeviceEnv {
  hostname: string;
  isSecureContext: boolean;
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  serviceWorker?: Pick<ServiceWorkerContainer, "register" | "getRegistration" | "ready">;
  pushSupported: boolean;
  notification?: {
    permission(): NotificationPermission;
    request(): Promise<NotificationPermission>;
  };
  subtle: Pick<SubtleCrypto, "digest">;
}

export function browserEnv(): DeviceEnv {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    hostname: location.hostname,
    isSecureContext: globalThis.isSecureContext === true,
    userAgent: nav.userAgent,
    maxTouchPoints: nav.maxTouchPoints,
    standalone: isStandalone(),
    ...(nav.serviceWorker ? { serviceWorker: nav.serviceWorker } : {}),
    pushSupported: "PushManager" in window,
    ...(typeof Notification === "undefined"
      ? {}
      : {
          notification: {
            permission: () => Notification.permission,
            request: () => Notification.requestPermission(),
          },
        }),
    subtle: crypto.subtle,
  };
}

// Opened from the Home Screen rather than in a browser tab.
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches)
  );
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isAppleTouch = (device: Pick<Navigator, "userAgent" | "maxTouchPoints">) =>
  /iPhone|iPad|iPod/.test(device.userAgent) ||
  (device.userAgent.includes("Macintosh") && device.maxTouchPoints > 1);

// Opened from an iPhone or iPad Home Screen. That app keeps its own storage, so it signs in apart
// from Safari; an app installed from a browser anywhere else shares the browser's.
export function isHomeScreenApp(
  device: Pick<Navigator, "userAgent" | "maxTouchPoints"> = navigator,
  standalone: boolean = isStandalone(),
): boolean {
  return standalone && isAppleTouch(device);
}

export function deviceLabel(userAgent: string, maxTouchPoints: number): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent) || (userAgent.includes("Macintosh") && maxTouchPoints > 1))
    return "iPad";
  if (/Android/.test(userAgent))
    return /Mobile/.test(userAgent) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows PC";
  return "This device";
}

// SHA-256 of the endpoint, first 8 bytes in hex: the id the daemon gives the same device.
export async function deviceIdOf(endpoint: string, subtle: DeviceEnv["subtle"]): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(endpoint)));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64urlBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function precheck(env: DeviceEnv): DeviceState | null {
  if (LOOPBACK.has(env.hostname) && deviceLabel(env.userAgent, env.maxTouchPoints) === "Mac")
    return { kind: "this-mac" };
  if (!env.isSecureContext) return { kind: "needs-https" };
  if (isAppleTouch(env) && !env.standalone) return { kind: "needs-home-screen" };
  if (!env.serviceWorker || !env.pushSupported || !env.notification) return { kind: "unsupported" };
  if (env.notification.permission() === "denied") return { kind: "blocked" };
  return null;
}

// known: the device ids the daemon has. A subscription the daemon forgot reads as off, so Turn on
// adds it again.
export async function deviceState(known: readonly string[], env: DeviceEnv): Promise<DeviceState> {
  const early = precheck(env);
  if (early) return early;
  const registration = await env.serviceWorker?.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return { kind: "off" };
  const id = await deviceIdOf(subscription.endpoint, env.subtle);
  return known.includes(id) ? { kind: "on", id } : { kind: "off" };
}

// Call straight from the click: iOS grants permission only inside the user's gesture, so the
// permission prompt comes before anything else is awaited.
export async function turnOnThisDevice(api: NotifyApi, env: DeviceEnv): Promise<DeviceState> {
  const early = precheck(env);
  if (early) return early;
  const permission = await env.notification?.request();
  if (permission === "denied") return { kind: "blocked" };
  if (permission !== "granted") return { kind: "off" };
  const container = env.serviceWorker;
  if (!container) return { kind: "unsupported" };
  await container.register("/sw.js", { scope: "/" });
  const registration = await container.ready;
  const applicationServerKey = base64urlBytes(await api.key());
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  } catch (error) {
    // A subscription made with an older key: replace it once.
    if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }
  const json = subscription.toJSON();
  const input: PushSubscriptionInput = {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    label: deviceLabel(env.userAgent, env.maxTouchPoints),
  };
  const device = await api.addDevice(input);
  return { kind: "on", id: device.id };
}

export async function turnOffThisDevice(api: NotifyApi, env: DeviceEnv): Promise<DeviceState> {
  const registration = await env.serviceWorker?.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return { kind: "off" };
  const id = await deviceIdOf(subscription.endpoint, env.subtle);
  await subscription.unsubscribe();
  try {
    await api.removeDevice(id);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  return { kind: "off" };
}

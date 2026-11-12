import type { BannerKind, NotifyEvent, NotifyTestResult, PushDevice } from "@localdot/protocol";
import { locale, t, tr } from "../i18n/index.ts";
import { ApiError } from "../lib/api.ts";
import type { DeviceState } from "../notify/this-device.ts";

export const EVENT_ROWS: readonly { event: NotifyEvent; label: string; description: string }[] = [
  { event: "needs_you", label: tr("Needs you"), description: tr("When dot waits for you") },
  { event: "done", label: tr("Done"), description: tr("A task finished") },
  { event: "failed", label: tr("Failed"), description: tr("Including budget pauses") },
  {
    event: "routine",
    label: tr("Routine results"),
    description: tr("When a routine has something"),
  },
];

export const MAC_BANNER_HINT = t`No banner on the Mac? Allow notifications for localDot in System Settings › Notifications.`;

export type DeviceAction = "turn-on" | "turn-off" | "copy-link";

export function deviceCopy(
  state: DeviceState,
  banner: BannerKind = "mac",
): { line: string; action: DeviceAction | null } {
  switch (state.kind) {
    case "this-mac":
      return {
        line:
          banner === "none"
            ? t`Notifications show here while this tab is open.`
            : t`Notifications come from localDot itself, even with no tab open.`,
        action: null,
      };
    case "needs-https":
      return {
        line:
          banner === "mac"
            ? t`To get notifications here, open localDot from your Mac's Tailscale address on this device.`
            : t`To get notifications here, open localDot from your computer's Tailscale address on this device.`,
        action: null,
      };
    case "needs-home-screen":
      return {
        line: state.bareAddress
          ? t`If you can, open localDot from its Tailscale link first: an iPhone doesn't trust this address's certificate, so the app would lose its icon. Add localDot to your Home Screen first: tap Share, then Add to Home Screen. Open it from there, paste this link to sign in, then turn notifications on.`
          : t`Add localDot to your Home Screen first: tap Share, then Add to Home Screen. Open it from there, paste this link to sign in, then turn notifications on.`,
        action: "copy-link",
      };
    case "unsupported":
      return { line: t`This browser can't show notifications.`, action: null };
    case "blocked":
      return {
        line: t`Notifications are blocked for localDot in this browser's settings.`,
        action: null,
      };
    case "off":
      return { line: t`Off on this device.`, action: "turn-on" };
    case "on":
      return { line: t`On for this device.`, action: "turn-off" };
  }
}

const one = (n: number) => new Intl.PluralRules("en").select(n) === "one";

// Where a test went, each way the computer running localDot is called in notification copy.
function sentLine(mac: boolean, shown: boolean, sent: number): string {
  if (!shown) return one(sent) ? t`Sent to ${sent} phone.` : t`Sent to ${sent} phones.`;
  if (mac) {
    if (!sent) return t`Sent to this Mac.`;
    return one(sent)
      ? t`Sent to this Mac and ${sent} phone.`
      : t`Sent to this Mac and ${sent} phones.`;
  }
  if (!sent) return t`Sent to this computer.`;
  return one(sent)
    ? t`Sent to this computer and ${sent} phone.`
    : t`Sent to this computer and ${sent} phones.`;
}

export function testResultLine(result: NotifyTestResult, banner: BannerKind = "mac"): string {
  const sent = result.phones.filter((phone) => phone.result === "sent").length;
  const mac = banner === "mac";
  const parts: string[] = [];
  if (result.mac === "shown") parts.push(sentLine(mac, true, sent));
  else if (sent) parts.push(sentLine(mac, false, sent));
  if (result.mac === "failed")
    parts.push(mac ? t`The Mac banner didn't show.` : t`The computer banner didn't show.`);
  for (const phone of result.phones) {
    if (phone.result === "gone")
      parts.push(t`${phone.label} stopped accepting notifications and was removed.`);
    if (phone.result === "failed")
      parts.push(t`${phone.label} didn't get it. Check its connection and try again.`);
  }
  if (!parts.length) return t`Nothing was sent: no phones are set up yet.`;
  if (result.mac !== "unavailable" && banner === "mac") parts.push(MAC_BANNER_HINT);
  return parts.join(" ");
}

export function deviceDetail(device: PushDevice): string {
  const added = new Intl.DateTimeFormat(locale() === "en" ? "en-GB" : locale(), {
    day: "numeric",
    month: "short",
  }).format(new Date(device.createdAt));
  return device.lastResult === "failed"
    ? t`Added ${added} · Last message failed`
    : t`Added ${added}`;
}

export function errorLine(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503)
      return t`Phone notifications are unavailable while localDot's key protection is offline. Try again in a moment.`;
    if ((error.status === 400 || error.status === 409) && error.message) return error.message;
  }
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return t`Notifications weren't allowed on this device.`;
  return t`That didn't work. Try again.`;
}

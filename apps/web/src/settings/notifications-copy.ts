import type { NotifyEvent, NotifyTestResult, PushDevice } from "@localdot/protocol";
import { ApiError } from "../lib/api.ts";
import type { DeviceState } from "../notify/this-device.ts";

export const EVENT_ROWS: readonly { event: NotifyEvent; label: string; description: string }[] = [
  { event: "needs_you", label: "Needs you", description: "Questions, approvals and take-overs" },
  { event: "done", label: "Done", description: "A task finished" },
  { event: "failed", label: "Failed", description: "Also when a task stops at its budget" },
  { event: "routine", label: "Routine results", description: "When a routine has something" },
];

export const SCRIPT_EDITOR_HINT =
  "No banner on the Mac? Allow notifications for Script Editor in System Settings › Notifications.";

export type DeviceAction = "turn-on" | "turn-off" | "copy-link";

export function deviceCopy(state: DeviceState): { line: string; action: DeviceAction | null } {
  switch (state.kind) {
    case "this-mac":
      return {
        line: "This Mac gets notifications from localDot itself, even with no tab open.",
        action: null,
      };
    case "needs-https":
      return {
        line: "To get notifications here, open localDot from your Mac's Tailscale address on this device.",
        action: null,
      };
    case "needs-home-screen":
      return {
        line: "Add localDot to your Home Screen first: tap Share, then Add to Home Screen. Open it from there, paste this link to sign in, then turn notifications on.",
        action: "copy-link",
      };
    case "unsupported":
      return { line: "This browser can't show notifications.", action: null };
    case "blocked":
      return {
        line: "Notifications are blocked for localDot in this browser's settings.",
        action: null,
      };
    case "off":
      return { line: "Off on this device.", action: "turn-on" };
    case "on":
      return { line: "On for this device.", action: "turn-off" };
  }
}

const phones = (n: number) =>
  `${n} ${new Intl.PluralRules("en").select(n) === "one" ? "phone" : "phones"}`;

export function testResultLine(result: NotifyTestResult): string {
  const sent = result.phones.filter((phone) => phone.result === "sent").length;
  const parts: string[] = [];
  if (result.mac === "shown")
    parts.push(sent ? `Sent to this Mac and ${phones(sent)}.` : "Sent to this Mac.");
  else if (sent) parts.push(`Sent to ${phones(sent)}.`);
  if (result.mac === "failed") parts.push("The Mac banner didn't show.");
  for (const phone of result.phones) {
    if (phone.result === "gone")
      parts.push(`${phone.label} stopped accepting notifications and was removed.`);
    if (phone.result === "failed")
      parts.push(`${phone.label} didn't get it. Check its connection and try again.`);
  }
  if (!parts.length) return "Nothing was sent: no phones are set up yet.";
  if (result.mac !== "unavailable") parts.push(SCRIPT_EDITOR_HINT);
  return parts.join(" ");
}

export function deviceDetail(device: PushDevice): string {
  const added = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(
    new Date(device.createdAt),
  );
  return device.lastResult === "failed" ? `Added ${added} · Last message failed` : `Added ${added}`;
}

export function errorLine(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503)
      return "Phone notifications are unavailable while localDot's key protection is offline. Try again in a moment.";
    if ((error.status === 400 || error.status === 409) && error.message) return error.message;
  }
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return "Notifications weren't allowed on this device.";
  return "That didn't work. Try again.";
}

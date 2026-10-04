import { ApprovalCard, type ApprovalCard as Card } from "@localdot/protocol";
export function notifyApproval(
  card: Card,
  owner: string,
  seen: Set<string>,
  focus: () => void,
): string | null {
  const parsed = ApprovalCard.safeParse(card);
  if (!parsed.success || parsed.data.expiresAt <= Date.now()) return null;
  if (typeof Notification === "undefined")
    return "Notifications are not supported here. Decisions remain visible in the app.";
  if (Notification.permission !== "granted")
    return Notification.permission === "denied"
      ? "Notifications are blocked in this browser. Decisions remain visible in the app."
      : null;
  const key = `${owner}:${parsed.data.approvalId}:${parsed.data.generation}:${parsed.data.revision}`;
  if (seen.has(key)) return null;
  seen.add(key);
  try {
    // Model previews may include private content. A notification contains only this fixed title.
    const notification = new Notification("localDot needs your decision", { tag: key });
    notification.onclick = () => {
      notification.close();
      focus();
    };
    return null;
  } catch {
    return "The notification could not be shown. Your decision remains visible in the app.";
  }
}

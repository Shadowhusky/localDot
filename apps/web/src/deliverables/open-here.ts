import type { ApiClient } from "../lib/api.ts";
import { showToast } from "../ui/Toast.tsx";
import { DeliverableError, openOnMac } from "./api.ts";

// These refusals from Open on Mac are written for people.
const SPOKEN = new Set([403, 415, 501]);

// Opens one stored version in its own app on this Mac and says how it went.
export async function openHere(
  api: ApiClient,
  sessionId: string,
  name: string,
  version: number | null,
): Promise<void> {
  try {
    await openOnMac(api, sessionId, name, version);
    showToast({ title: `Opened ${name} on your Mac`, tone: "success" });
  } catch (error) {
    const said = error instanceof DeliverableError && SPOKEN.has(error.status) && error.message;
    showToast({ title: said || `Couldn't open ${name} on your Mac.`, tone: "danger" });
  }
}

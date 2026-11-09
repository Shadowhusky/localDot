import type { GuestAccess } from "@localdot/protocol";
import type { MemoryStore } from "./memory.ts";
import type { ToolDeps } from "./tools/deps.ts";

// What a task that came through a shared link is told when it reaches for something of the owner's.
export const GUEST_NO_BROWSER =
  "This task came through a shared link that doesn't include the owner's web browser and its sign-ins. Open sites with browser_navigate, in the desktop's Chromium.";
export const guestRefusal = (tool: string) =>
  `This task came through a shared link: ${tool} isn't available to it. Carry on without it, or ask the person you're working for.`;

// The owner's connected apps, saved keys and signed-in web browser.
export const usesOwnersAccounts = (guest: GuestAccess | undefined) => !guest || guest.apps;

// A task that came through a shared link starts with none of the owner's memory.
export function bootMemory(
  memory: Pick<MemoryStore, "bootMemory">,
  session: { readonly task: string; readonly guest: GuestAccess | undefined },
  contextTokens?: number,
): { user: string; memory: string } {
  return session.guest ? { user: "", memory: "" } : memory.bootMemory(session.task, contextTokens);
}

// What a shared link's task's tools can reach: none of the owner's history, contacts or schedule,
// and their saved sign-ins, keys and apps only when the link allows them.
export function toolsFor(tools: ToolDeps, guest: GuestAccess | undefined): ToolDeps {
  if (!guest) return tools;
  const {
    recall: _recall,
    recallExperience: _experience,
    saveExperience: _lessons,
    people: _people,
    routines: _routines,
    ...rest
  } = tools;
  if (guest.apps) return rest;
  const { logins: _logins, credentials: _credentials, connectors: _connectors, ...closed } = rest;
  return closed;
}

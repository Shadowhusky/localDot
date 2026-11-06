import { setTimeout as sleep } from "node:timers/promises";
import type { ManualInput } from "@localdot/protocol";
import { loginOrigins, signInNeedsOwnBrowser } from "../../../../packages/protocol/src/accounts.ts";
import type { BrowserSignInPage } from "../../../../packages/protocol/src/browser-secret.ts";
import type {
  UserBrowserFill,
  UserBrowserSignInPage,
} from "../../../../packages/protocol/src/browser-sign-in.ts";
import { type KeydClient, VaultLockedError } from "../keyd/client.ts";
import { BrowserClientError } from "./client.ts";

export type SavedLoginKeys = Pick<KeydClient, "findLogin" | "login">;

const PAGE_TRIES = 5;
const PAGE_RETRY_MS = 400;

// What the user's own hold of the web browser can do with a saved login.
export interface SignInHold {
  signInPage(fields: boolean): Promise<BrowserSignInPage | null>;
  fillSecret(
    tabId: string,
    request: { origin: string; at: { x: number; y: number }; username?: string; text: string },
  ): Promise<{ filled: boolean; submitted?: boolean }>;
  input(input: ManualInput): Promise<unknown>;
  check(): void;
  // Kept out of whatever this task records from now on.
  secretFilled(value: string): void;
  readonly selection: { readonly geometry: { readonly scale: 1 | 2 } };
}

async function savedFor(keys: SavedLoginKeys, origin: string) {
  for (const candidate of loginOrigins(origin)) {
    const entry = await keys.findLogin(candidate);
    if (entry) return entry;
  }
  return undefined;
}

// What the page in front asks of the user: to sign in without agent control on a site that turns a
// controlled browser away, or to use their saved login. Nothing when it can't be read.
export async function signInPageAsks(
  hold: Pick<SignInHold, "signInPage" | "check">,
  keys: SavedLoginKeys,
): Promise<UserBrowserSignInPage | undefined> {
  const page = await hold.signInPage(false).catch(() => null);
  hold.check();
  if (!page?.origin) return undefined;
  if (signInNeedsOwnBrowser(page.origin)) return { ownBrowser: true };
  const saved = await savedFor(keys, page.origin).catch(() => undefined);
  hold.check();
  return saved
    ? { saved: { site: new URL(saved.origin).host, username: saved.username } }
    : undefined;
}

// The user's tap on their saved login: the site they see now decides which login, and every
// character is bound to it in browserd, as an agent's secret is. The password goes from keyd to the
// page; what comes back says only how it went. `passwordOnly`: the same tap, on the page after the
// one that took the account, which must not take it twice while it loads.
export async function fillSavedLogin(
  hold: SignInHold,
  keys: SavedLoginKeys,
  passwordOnly = false,
): Promise<UserBrowserFill> {
  try {
    const page = await settledPage(hold);
    hold.check();
    if (!page?.origin || signInNeedsOwnBrowser(page.origin)) return "refused";
    if (!page.field || (passwordOnly && page.field.kind !== "password")) return "no-field";
    const saved = await savedFor(keys, page.origin);
    hold.check();
    if (!saved) return "refused";
    if (page.field.kind === "account") return await typeAccount(hold, page, saved.username);
    const login = await keys.login(saved.origin);
    hold.check();
    if (!login) return "refused";
    try {
      hold.secretFilled(login.password);
      const landed = await hold.fillSecret(page.tabId, {
        origin: page.origin,
        at: page.field.at,
        ...(login.username ? { username: login.username } : {}),
        text: login.password,
      });
      if (!landed.filled) return "refused";
      return landed.submitted ? "submitted" : "filled";
    } finally {
      login.password = "";
    }
  } catch (error) {
    hold.check();
    if (error instanceof VaultLockedError) return "locked";
    if (error instanceof BrowserClientError && error.code === "login_form") return "form";
    return "refused";
  }
}

// A busy browser can fail to say what its window shows for a moment. Nothing has been typed yet, so
// asking again is safe.
async function settledPage(hold: SignInHold): Promise<BrowserSignInPage | null> {
  for (let tries = 1; ; tries++) {
    const page = await hold.signInPage(true);
    if (page || tries >= PAGE_TRIES) return page;
    hold.check();
    await sleep(PAGE_RETRY_MS);
    hold.check();
  }
}

// A page that asks for the account first takes it as the user's own typing would, once the field
// is still the one found on the same site. The password follows on the page after it.
async function typeAccount(
  hold: SignInHold,
  page: BrowserSignInPage,
  username: string,
): Promise<UserBrowserFill> {
  if (!username || !page.field) return "no-field";
  const { scale } = hold.selection.geometry;
  await hold.input({
    kind: "click",
    at: { x: page.field.at.x * scale, y: page.field.at.y * scale },
    button: "left",
    count: 1,
  });
  hold.check();
  const after = await hold.signInPage(false);
  hold.check();
  if (after?.origin !== page.origin || after.tabId !== page.tabId) return "refused";
  await hold.input({ kind: "key", combo: ["ctrl", "a"] });
  hold.check();
  await hold.input({ kind: "text", text: username });
  hold.check();
  await hold.input({ kind: "key", combo: ["Return"] });
  hold.check();
  return "account";
}

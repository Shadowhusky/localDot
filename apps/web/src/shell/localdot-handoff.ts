import { Accessory, type AgentSettingsDocument, LocalDotLink, PersonaId } from "@localdot/protocol";
import { useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { sharedToken, storedToken } from "../lib/token.ts";
import { localDotLink } from "./local-dots.ts";

// What one localDot tells another as the user switches there: its address and how it looks.
// Nothing else crosses, and nothing in it signs anyone in.
export const LocalDotProfile = z.strictObject({
  url: LocalDotLink.shape.url,
  name: LocalDotLink.shape.name.optional(),
  persona: PersonaId.optional(),
  accessory: Accessory.optional(),
});
export type LocalDotProfile = z.infer<typeof LocalDotProfile>;

// An entry in the localDot menu: the user's list here, then the ones only this browser has come
// from. A name the user gave wins over the one that localDot gave itself.
export interface OtherLocalDot extends LocalDotLink {
  persona?: PersonaId;
  accessory?: Accessory;
  browserOnly: boolean;
}

const KEYS = new Set(["from", "name", "persona", "accessory"]);
const STORE = "localdot.other-localdots";
const KEEP = 12;
const Known = z.array(LocalDotProfile).max(KEEP);

// Another localDot's address with this one's profile in the fragment, which never reaches a server.
export function handoffUrl(target: string, self: LocalDotProfile): string {
  const fragment = new URLSearchParams({ from: self.url });
  if (self.name) fragment.set("name", self.name);
  if (self.persona) fragment.set("persona", self.persona);
  if (self.accessory) fragment.set("accessory", self.accessory);
  return `${new URL(target).origin}/#${fragment}`;
}

// Goes there in this tab. This page's origin goes with it as the referrer, and nothing more of its
// address, so that localDot can check the profile came from the page it names.
export function openLocalDot(target: string, self: LocalDotProfile, doc: Document = document) {
  const link = doc.createElement("a");
  link.href = handoffUrl(target, self);
  link.referrerPolicy = "origin";
  doc.body.append(link);
  link.click();
  link.remove();
}

export interface ArrivalHost {
  location: { hash: string; pathname: string; search: string; origin: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
  document: { referrer: string };
}

const originOf = (url: string) => (URL.canParse(url) ? new URL(url).origin : null);

// The profile of the localDot that sent this page here, taken off the address. The browser names
// the page that sent it, so a link from anywhere else, or one naming another address, gives null.
export function takeArrival(host: ArrivalHost = window): LocalDotProfile | null {
  const fragment = new URLSearchParams(host.location.hash.replace(/^#/, ""));
  const keys = [...fragment.keys()];
  if (!fragment.has("from") || keys.some((key) => !KEYS.has(key))) return null;
  host.history.replaceState(null, "", `${host.location.pathname}${host.location.search}`);
  const from = fragment.get("from") ?? "";
  if (
    new Set(keys).size !== keys.length ||
    originOf(from) !== from ||
    originOf(host.document.referrer) !== from ||
    from === host.location.origin
  )
    return null;
  const url = LocalDotLink.shape.url.safeParse(from);
  if (!url.success) return null;
  const name = LocalDotLink.shape.name.safeParse(fragment.get("name"));
  const persona = PersonaId.safeParse(fragment.get("persona"));
  const accessory = Accessory.safeParse(fragment.get("accessory"));
  return {
    url: url.data,
    ...(name.success ? { name: name.data } : {}),
    ...(persona.success ? { persona: persona.data } : {}),
    ...(accessory.success ? { accessory: accessory.data } : {}),
  };
}

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function local(): BrowserStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let cached: { raw: string | null; list: readonly LocalDotProfile[] } = { raw: null, list: [] };

function read(storage: BrowserStorage | null): readonly LocalDotProfile[] {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(STORE) ?? null;
  } catch {}
  if (raw === cached.raw) return cached.list;
  let list: readonly LocalDotProfile[] = [];
  try {
    const parsed = Known.safeParse(JSON.parse(raw ?? "[]"));
    if (parsed.success) list = parsed.data;
  } catch {}
  cached = { raw, list };
  return list;
}

function write(storage: BrowserStorage | null, list: readonly LocalDotProfile[]) {
  try {
    storage?.setItem(STORE, JSON.stringify(list));
  } catch {}
  for (const listener of listeners) listener();
}

// The localDots this browser has come from, newest first. They live only in this browser, never in
// this localDot's settings, which every device shares.
export function knownLocalDots(storage = local()): readonly LocalDotProfile[] {
  return read(storage);
}

export function rememberLocalDot(profile: LocalDotProfile, storage = local()) {
  const others = read(storage).filter((other) => other.url !== profile.url);
  write(storage, [LocalDotProfile.parse(profile), ...others].slice(0, KEEP));
}

export function forgetLocalDot(url: string, storage = local()) {
  const list = read(storage);
  if (list.some((other) => other.url === url)) {
    write(
      storage,
      list.filter((other) => other.url !== url),
    );
  }
}

// Run once, before the app reads the address. Only a browser signed in here as the owner keeps
// what arrived: never a shared link's guest, and never a browser that isn't signed in.
export function rememberArrival(host: ArrivalHost & { localStorage: BrowserStorage } = window) {
  const arrival = takeArrival(host);
  const token = storedToken(host);
  if (arrival && token && !sharedToken(token)) rememberLocalDot(arrival, host.localStorage);
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useKnownLocalDots(): readonly LocalDotProfile[] {
  return useSyncExternalStore(subscribe, knownLocalDots, () => cached.list);
}

const NO_LINKS: readonly LocalDotLink[] = [];

export interface OtherLocalDots {
  list: readonly OtherLocalDot[];
  open(url: string): void;
}

// The user's other localDots as this browser knows them, and the way to each, taking this one's
// profile along.
export function useOtherLocalDots(
  saved: Pick<AgentSettingsDocument, "name" | "persona" | "accessory" | "localDots"> | null,
): OtherLocalDots {
  const known = useKnownLocalDots();
  const listed = saved?.localDots ?? NO_LINKS;
  const name = saved?.name;
  const persona = saved?.persona;
  const accessory = saved?.accessory;
  return useMemo(
    () => ({
      list: otherLocalDots(listed, known),
      open: (url: string) =>
        openLocalDot(url, {
          url: window.location.origin,
          ...(name ? { name } : {}),
          ...(persona ? { persona } : {}),
          ...(accessory ? { accessory } : {}),
        }),
    }),
    [listed, known, name, persona, accessory],
  );
}

const fallbackName = (url: string) => localDotLink("", url)?.name ?? url;

export function otherLocalDots(
  listed: readonly LocalDotLink[],
  known: readonly LocalDotProfile[],
): OtherLocalDot[] {
  const learned = new Map(known.map((profile) => [profile.url, profile]));
  const urls = new Set(listed.map((link) => link.url));
  const entry = (link: LocalDotLink, browserOnly: boolean): OtherLocalDot => {
    const profile = learned.get(link.url);
    return {
      name: profile?.name && link.name === fallbackName(link.url) ? profile.name : link.name,
      url: link.url,
      ...(profile?.persona ? { persona: profile.persona } : {}),
      ...(profile?.accessory ? { accessory: profile.accessory } : {}),
      browserOnly,
    };
  };
  return [
    ...listed.map((link) => entry(link, false)),
    ...known
      .filter((profile) => !urls.has(profile.url))
      .map((profile) =>
        entry({ name: profile.name ?? fallbackName(profile.url), url: profile.url }, true),
      ),
  ];
}

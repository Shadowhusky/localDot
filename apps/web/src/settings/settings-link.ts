import { SECTIONS, type SettingsSection } from "./sections.ts";

// What a link or a button elsewhere can send the user to do in Settings, by its element's id:
// the section's name and the tip's. The tip is lit once as it comes into view.
export const SETTINGS_TIPS = {
  "keys-unlock": "keys",
  "keys-protection": "keys",
  "models-chatgpt": "models",
  "models-claude-code": "models",
} as const satisfies Record<string, SettingsSection>;
export type SettingsTip = keyof typeof SETTINGS_TIPS;

export interface SettingsPlace {
  section: SettingsSection;
  tip?: SettingsTip;
}

interface SettingsLinkHost {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
}

// "#settings=keys&tip=unlock" opens Keys at its unlock form. Read once and taken off the address.
export function takeSettingsLink(host: SettingsLinkHost = window): SettingsPlace | null {
  const params = new URLSearchParams(host.location.hash.replace(/^#/, ""));
  const section = params.get("settings");
  if (section === null) return null;
  host.history.replaceState(null, "", `${host.location.pathname}${host.location.search}`);
  const known = SECTIONS.find((info) => info.id === section)?.id;
  if (!known) return null;
  const tip = `${known}-${params.get("tip")}`;
  return tip in SETTINGS_TIPS && SETTINGS_TIPS[tip as SettingsTip] === known
    ? { section: known, tip: tip as SettingsTip }
    : { section: known };
}

export function listenForSettingsLinks(
  open: (place: SettingsPlace) => void,
  host: SettingsLinkHost & Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const fromHash = () => {
    const place = takeSettingsLink(host);
    if (place) open(place);
  };
  host.addEventListener("hashchange", fromHash);
  fromHash();
  return () => host.removeEventListener("hashchange", fromHash);
}

import { useEffect, useState } from "react";
import { t, tr } from "../i18n/index.ts";
import { useMediaQuery } from "../ui/media.ts";

// How localDot is laid out on this device: Chat, the stack of the list, the conversation and the
// computer, or Studio, the computer and its panels together on one screen.
export type ViewStyle = "chat" | "studio";
export const VIEW_STYLES: readonly ViewStyle[] = ["chat", "studio"];

// What the two are called and what they are, the one place that says so.
export const VIEW_NAMES: Readonly<Record<ViewStyle, string>> = {
  chat: tr("Chat"),
  studio: tr("Studio"),
};
export const VIEW_LINES: Readonly<Record<ViewStyle, string>> = {
  chat: tr("Text dot like a friend, with the computer a tap away."),
  studio: tr("The computer, the chat and every step on one screen."),
};

export const VIEW_STYLE_KEY = "localdot.view-style.v1";
export const VIEWS_TRIED_KEY = "localdot.view-style-tried.v1";

// A phone, however it is held; a desktop window as narrow as one is still a desktop.
const PHONE_DEVICE =
  "(pointer: coarse) and (width < 700px), (pointer: coarse) and (orientation: landscape) and (height < 500px)";

export const otherView = (style: ViewStyle): ViewStyle => (style === "chat" ? "studio" : "chat");
export const switchViewLabel = (style: ViewStyle) =>
  t`Switch to ${VIEW_NAMES[otherView(style)]} view`;

function storedView(): ViewStyle | null {
  try {
    const value = localStorage.getItem(VIEW_STYLE_KEY);
    return value === "chat" || value === "studio" ? value : null;
  } catch {
    return null;
  }
}

function storedTried(): boolean {
  try {
    return localStorage.getItem(VIEWS_TRIED_KEY) === "on";
  } catch {
    return false;
  }
}

// Kept per device: Studio on the Mac and Chat on the phone is a fair choice. Until one is made, a
// phone has Chat and anything else Studio.
export function useViewStyle() {
  const phone = useMediaQuery(PHONE_DEVICE);
  const [chosen, setChosen] = useState(storedView);
  const [tried, setTried] = useState(storedTried);
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === VIEW_STYLE_KEY || event.key === null) setChosen(storedView());
      if (event.key === VIEWS_TRIED_KEY || event.key === null) setTried(storedTried());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const recommended: ViewStyle = phone ? "chat" : "studio";
  const value = chosen ?? recommended;
  const choose = (next: ViewStyle) => {
    setChosen(next);
    try {
      localStorage.setItem(VIEW_STYLE_KEY, next);
      setSaved(true);
    } catch {
      setSaved(false);
    }
  };
  return {
    value,
    recommended,
    saved,
    // This person has been in the other style, so dot needn't suggest it again.
    tried,
    // Picked in setup, before either has been seen.
    choose,
    // Moved to, as from a menu.
    change(next: ViewStyle) {
      if (next !== value) {
        setTried(true);
        try {
          localStorage.setItem(VIEWS_TRIED_KEY, "on");
        } catch {}
      }
      choose(next);
    },
  };
}

export type ViewStyleControl = ReturnType<typeof useViewStyle>;

import type { SettingsSection } from "../settings/sections.ts";

// What dot says beside the stage while nothing is going on: a greeting on the first quiet moment of
// a visit, then one tip at a time. Edit freely. Every line is dot's own words: plain, short, no
// exclamation marks. A tip with an action keeps to about 60 characters, so a phone shows it, action
// and all, in two lines.

export type DayPart = "morning" | "afternoon" | "evening" | "night";

// Morning 5–11, afternoon 12–17, evening 18–22, night 23–4.
export const GREETINGS: Readonly<Record<DayPart, readonly string[]>> = {
  morning: [
    "Morning. What are we doing today?",
    "Good morning. I'm up, and so is my computer.",
    "Morning. Hand me the dull jobs first.",
  ],
  afternoon: [
    "Afternoon. What needs doing?",
    "Good afternoon. Anything I can take off your hands?",
    "Afternoon. Got something tedious for me?",
  ],
  evening: [
    "Evening. Anything left over from today?",
    "Good evening. Something quick before you log off?",
    "Evening. I'll take the boring bits.",
  ],
  night: [
    "Still up? What do you need?",
    "Late one. Tell me what to do and get some sleep.",
    "It's late. I don't get tired, so ask away.",
  ],
};

// What the app knows about this viewer and this Mac. Undefined means it can't tell yet.
export interface TipSignals {
  // A touch screen or a phone: no keyboard to press.
  touch: boolean;
  apple: boolean;
  // There are recordings to open in Replay.
  recordings: boolean;
  routines?: number;
  exported?: boolean;
  purposeCheck?: boolean;
  openAtLogin?: "on" | "off" | "unavailable";
  // A new version of the computer is ready.
  update: boolean;
  // The computer can be erased and started clean right now.
  freshStart: boolean;
}

// The one small step a tip offers: a section of Settings (`finds` is what that section shows for
// the feature, which a test looks for), Replay, or a new routine.
export type TipAction =
  | { label: string; opens: "settings"; section: SettingsSection; finds: string }
  | { label: string; opens: "replay" }
  | { label: string; opens: "routine" };

export interface Tip {
  id: string;
  text: string | ((signals: TipSignals) => string);
  action?: TipAction;
  // Only where the feature is there to use; always when left out.
  shows?(signals: TipSignals): boolean;
  // Whether the user has used the feature, when the app can tell. Unused ones come first.
  used?(signals: TipSignals): boolean | undefined;
}

// In the order they show, after any for features the user hasn't tried.
export const TIPS: readonly Tip[] = [
  {
    id: "take-control",
    text: "Press the hand to take over. I won't sulk.",
  },
  {
    id: "routine",
    text: "Tell me “every weekday at 9…” and I'll draft a routine.",
    action: { label: "Try it", opens: "routine" },
    used: (s) => (s.routines === undefined ? undefined : s.routines > 0),
  },
  {
    id: "passwords",
    text: "Passwords I ask for go straight into the page. I never see them.",
  },
  {
    id: "full-screen",
    text: "Double-click my screen, or press F, for full screen.",
    shows: (s) => !s.touch,
  },
  {
    id: "replay-export",
    text: "Replay keeps every task. Trim the good bit and export it.",
    action: { label: "Open", opens: "replay" },
    shows: (s) => s.recordings,
    used: (s) => s.exported,
  },
  {
    id: "files",
    text: "Files I make open right in the chat. No downloading to peek.",
  },
  {
    id: "stop-key",
    text: (s) => `${s.apple ? "⌘⇧." : "Ctrl+Shift+."} stops me mid-task. No questions asked.`,
    shows: (s) => !s.touch,
  },
  {
    id: "memory",
    text: "What I remember about you is yours to edit or delete.",
    action: { label: "Open", opens: "settings", section: "knowledge", finds: "What dot knows" },
  },
  {
    id: "purpose-check",
    text: "Purpose check keeps what I read from wandering off.",
    action: { label: "Open", opens: "settings", section: "autonomy", finds: "Purpose check" },
    used: (s) => s.purposeCheck,
  },
  {
    id: "showcase",
    text: "Showcase puts me in the video. I'm told I'm photogenic.",
    action: { label: "Open", opens: "replay" },
    shows: (s) => s.recordings,
    used: (s) => s.exported,
  },
  {
    id: "slash",
    text: "Press / anywhere to start typing to me.",
    shows: (s) => !s.touch,
  },
  {
    id: "stop-everything",
    text: "If it all goes sideways, Stop everything halts the lot.",
    action: { label: "Open", opens: "settings", section: "computer", finds: "Stop everything" },
  },
  {
    id: "phone",
    text: "Put localDot on your tailnet and I'm on your phone too.",
    shows: (s) => !s.touch,
  },
  {
    id: "open-at-login",
    text: "Turn on Open at login and routines run without you.",
    action: { label: "Open", opens: "settings", section: "computer", finds: "Open at login" },
    shows: (s) => s.openAtLogin === "off",
    used: () => false,
  },
  {
    id: "setup",
    text: "Want the setup again? Settings has it, step by step.",
    action: { label: "Open", opens: "settings", section: "models", finds: "Set up step by step" },
  },
  {
    id: "start-fresh",
    text: "Start fresh wipes my computer clean. Sign-ins stay.",
    action: { label: "Open", opens: "settings", section: "computer", finds: "Start fresh" },
    shows: (s) => s.freshStart,
  },
  {
    id: "update",
    text: "My computer has an update ready. It's one press in Settings.",
    action: { label: "Open", opens: "settings", section: "computer", finds: "Update" },
    shows: (s) => s.update,
    used: () => false,
  },
];

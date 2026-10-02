// Labels and names come from accessibility trees and page titles, which can hold anything; every
// string that enters an event is cut to its schema limit in code points (Review Focus 3).
export function clipText(text: string, max: number): string {
  const clean = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

// One name per key for the gateway's labels and the stage's keycaps: the guest is Linux, so names
// rather than macOS glyphs (research §4.3.6).
const KEY_DISPLAY: Record<string, string> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  control_l: "Ctrl",
  alt: "Alt",
  alt_l: "Alt",
  shift: "Shift",
  shift_l: "Shift",
  cmd: "Super",
  super: "Super",
  super_l: "Super",
  win: "Super",
  enter: "Return",
  return: "Return",
  esc: "Esc",
  escape: "Esc",
  space: "Space",
  backspace: "Backspace",
  tab: "Tab",
};

export function keyDisplayName(key: string): string {
  return KEY_DISPLAY[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key);
}

import { z } from "zod";

export const boundedText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((text) => [...text].length <= max, {
      message: `Too long: expected at most ${max} code points`,
    });

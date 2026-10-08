import { clsx } from "clsx";
import { VisuallyHidden } from "./VisuallyHidden.tsx";

interface Spelling {
  label: string;
  spoken: string;
  aria: string;
}

// Mod is Command on Apple devices and Control elsewhere.
const NAMED: Record<string, { mac: Spelling; other: Spelling }> = {
  Mod: {
    mac: { label: "⌘", spoken: "Command", aria: "Meta" },
    other: { label: "Ctrl", spoken: "Control", aria: "Control" },
  },
  Ctrl: {
    mac: { label: "⌃", spoken: "Control", aria: "Control" },
    other: { label: "Ctrl", spoken: "Control", aria: "Control" },
  },
  Alt: {
    mac: { label: "⌥", spoken: "Option", aria: "Alt" },
    other: { label: "Alt", spoken: "Alt", aria: "Alt" },
  },
  Shift: {
    mac: { label: "⇧", spoken: "Shift", aria: "Shift" },
    other: { label: "Shift", spoken: "Shift", aria: "Shift" },
  },
  Enter: {
    mac: { label: "↩", spoken: "Return", aria: "Enter" },
    other: { label: "Enter", spoken: "Enter", aria: "Enter" },
  },
  Escape: {
    mac: { label: "Esc", spoken: "Escape", aria: "Escape" },
    other: { label: "Esc", spoken: "Escape", aria: "Escape" },
  },
  Backspace: {
    mac: { label: "⌫", spoken: "Delete", aria: "Backspace" },
    other: { label: "Backspace", spoken: "Backspace", aria: "Backspace" },
  },
};

function spell(key: string, mac: boolean): Spelling {
  const named = NAMED[key];
  if (named) return mac ? named.mac : named.other;
  const label = key.length === 1 ? key.toUpperCase() : key;
  return { label, spoken: label, aria: key };
}

export function isApple(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform);
}

export function formatKeys(keys: readonly string[], mac = isApple()): Spelling {
  const spelled = keys.map((key) => spell(key, mac));
  return {
    label: spelled.map((key) => key.label).join(mac ? "" : "+"),
    spoken: spelled.map((key) => key.spoken).join(" "),
    aria: spelled.map((key) => key.aria).join("+"),
  };
}

export interface KbdProps {
  keys: readonly string[];
  className?: string;
}

export function Kbd({ keys, className }: KbdProps) {
  const { label, spoken } = formatKeys(keys);
  return (
    <kbd className={clsx("ui-kbd", className)}>
      <span aria-hidden="true">{label}</span>
      <VisuallyHidden>{spoken}</VisuallyHidden>
    </kbd>
  );
}

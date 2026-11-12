import { t } from "../i18n/index.ts";
import type { VoiceFailure } from "./capture.ts";
import type { VoiceRoute } from "./support.ts";

export const LISTENING_LINE = t`Listening…`;

// What to call the computer running localDot, as its own status says.
export type ComputerWord = "Mac" | "computer";

export function routeLabel(route: VoiceRoute, computer: ComputerWord = "Mac"): string {
  switch (route.kind) {
    case "device":
      return t`On this device`;
    case "mac":
      return computer === "Mac" ? t`On your Mac` : t`On your computer`;
    case "online":
      return t`Online`;
    case "none":
      return route.why === "checking" ? "" : t`Off`;
  }
}

// One line on where the words are made, for Settings.
export function routeDetail(route: VoiceRoute, computer: ComputerWord = "Mac"): string {
  switch (route.kind) {
    case "device":
      return t`Your browser turns speech into text without sending audio anywhere.`;
    case "mac":
      return computer === "Mac"
        ? t`The speech model on your Mac turns it into text. Audio goes nowhere else.`
        : t`The speech model on your computer turns it into text. Audio goes nowhere else.`;
    case "online":
      return t`Your browser's online speech service hears what you say.`;
    case "none":
      switch (route.why) {
        case "checking":
          return t`Checking speech support…`;
        case "insecure":
          return t`Microphone access needs HTTPS. Open your secure remote link, or use localhost on the computer running localDot.`;
        case "download":
          return t`This browser can do it on this device after a one-time download.`;
        case "online-off":
          return t`This browser can only do it online. Allow online speech below to use it.`;
        case "unsupported":
          return t`This browser can't turn speech into text.`;
      }
  }
}

// Why the mic can't be used, as its tooltip says it.
export function routeBlocked(route: VoiceRoute): string | undefined {
  if (route.kind !== "none" || route.why === "download") return undefined;
  if (route.why === "checking")
    return t`Checking speech support. Try the microphone again in a moment.`;
  if (route.why === "insecure") return routeDetail(route);
  return route.why === "online-off"
    ? t`To use voice here, allow your browser’s online speech service to receive your audio.`
    : t`This browser can't turn speech into text.`;
}

export function failureLine(failure: VoiceFailure): string {
  switch (failure) {
    case "denied":
      return t`Allow the microphone to talk to dot.`;
    case "no-mic":
      return t`The microphone isn’t receiving audio. Try again.`;
    case "no-speech":
      return t`Didn't catch that. Try again.`;
    case "unavailable":
      return t`Speech to text isn't available here.`;
    case "network":
      return t`Couldn't reach the speech service.`;
    case "busy":
      return t`Still writing down your last words.`;
    case "failed":
      return t`Couldn't turn that into text.`;
  }
}

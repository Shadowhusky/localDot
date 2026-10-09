import type { VoiceFailure } from "./capture.ts";
import type { VoiceRoute } from "./support.ts";

export const LISTENING_LINE = "Listening…";

export function routeLabel(route: VoiceRoute): string {
  switch (route.kind) {
    case "device":
      return "On this device";
    case "mac":
      return "On your Mac";
    case "online":
      return "Online";
    case "none":
      return route.why === "checking" ? "" : "Off";
  }
}

// One line on where the words are made, for Settings.
export function routeDetail(route: VoiceRoute): string {
  switch (route.kind) {
    case "device":
      return "Your browser turns speech into text without sending audio anywhere.";
    case "mac":
      return "The speech model on your Mac turns it into text. Audio goes nowhere else.";
    case "online":
      return "Your browser's online speech service hears what you say.";
    case "none":
      switch (route.why) {
        case "checking":
          return "";
        case "download":
          return "This browser can do it on this device after a one-time download.";
        case "online-off":
          return "This browser can only do it online. Allow online speech below to use it.";
        case "unsupported":
          return "This browser can't turn speech into text.";
      }
  }
}

// Why the mic can't be used, as its tooltip says it.
export function routeBlocked(route: VoiceRoute): string | undefined {
  if (route.kind !== "none" || route.why === "checking" || route.why === "download")
    return undefined;
  return route.why === "online-off"
    ? "Allow online speech in Settings › Voice to talk here."
    : "This browser can't turn speech into text.";
}

export function failureLine(failure: VoiceFailure): string {
  switch (failure) {
    case "denied":
      return "Allow the microphone to talk to dot.";
    case "no-mic":
      return "No microphone found.";
    case "no-speech":
      return "Didn't catch that. Try again.";
    case "unavailable":
      return "Speech to text isn't available here.";
    case "network":
      return "Couldn't reach the speech service.";
    case "busy":
      return "Still writing down your last words.";
    case "failed":
      return "Couldn't turn that into text.";
  }
}

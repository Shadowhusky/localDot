import type { PushKind } from "@localdot/protocol";
import { tr } from "../i18n/index.ts";

// A notification's words in the language on show. The protocol's own are English, for the Mac's
// banners and phone pushes the daemon sends; the page shows these.
export function notifyCopy(kind: PushKind): { title: string; body: string } {
  switch (kind) {
    case "needs_you":
      return { title: tr("dot needs you"), body: tr("Open localDot to answer.") };
    case "blocked":
      return {
        title: tr("Task paused: budget reached"),
        body: tr("Open localDot to raise it or stop."),
      };
    case "done":
      return { title: tr("Task done"), body: tr("Open localDot to see the result.") };
    case "failed":
      return { title: tr("Task failed"), body: tr("Open localDot to see what happened.") };
    case "routine":
      return { title: tr("Routine update"), body: tr("Open localDot to see the result.") };
    case "test":
      return { title: tr("Notifications are on"), body: tr("This is a test from localDot.") };
  }
}

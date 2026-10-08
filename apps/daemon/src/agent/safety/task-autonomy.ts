import type { ScreenName } from "@localdot/protocol";

// Per-task autonomy state, never persisted. The browser screen holds the user's logins; the
// desktop's browser starts empty each task, so it counts as signed in only after the user
// signed in on it during this task.
export class TaskAutonomy {
  #desktopSignedIn = false;
  signedIn(screen: ScreenName): boolean {
    return screen === "browser" || this.#desktopSignedIn;
  }
  signIn(screen: ScreenName): void {
    if (screen === "desktop") this.#desktopSignedIn = true;
  }
}

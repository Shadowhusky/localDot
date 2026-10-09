import type { CodexInstallFailure } from "@localdot/protocol";
import type { GlyphState } from "../ui/StatusGlyph.tsx";
import type { ChatgptSummary } from "./chatgpt-api.ts";

export const INSTALL_FAILURES: Record<CodexInstallFailure, string> = {
  unsupported_platform: "ChatGPT support is unavailable on this platform.",
  download_failed: "The download didn't finish. Check the connection and try again.",
  integrity_failed: "The download didn't pass its check. Try the download again.",
  unsafe_archive: "The download couldn't be installed safely. Try the download again.",
  storage_failed: "ChatGPT support couldn't be saved. Check free space and try again.",
  cancelled: "Installation was cancelled. You can install again when ready.",
};

export interface ChatgptStep {
  id: "install" | "check" | "sign-in";
  title: string;
  detail: string;
  state: GlyphState;
}

export const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function install(summary: ChatgptSummary, starting: boolean): ChatgptStep {
  const step = { id: "install", title: "Install ChatGPT support" } as const;
  const value = summary.install;
  switch (value.state) {
    case "ready":
      return { ...step, state: "done", detail: "Installed" };
    case "failed":
      return { ...step, state: "failed", detail: INSTALL_FAILURES[value.code] };
    case "verifying":
      return { ...step, state: "doing", detail: "Checking the download…" };
    case "downloading":
      return {
        ...step,
        state: "doing",
        detail:
          value.totalBytes === undefined
            ? `Downloading… ${megabytes(value.receivedBytes)}`
            : `Downloading… ${megabytes(value.receivedBytes)} of ${megabytes(value.totalBytes)}`,
      };
    default:
      return starting
        ? { ...step, state: "doing", detail: "Starting the download…" }
        : { ...step, state: "todo", detail: "A one-time download" };
  }
}

function check(summary: ChatgptSummary): ChatgptStep {
  const step = { id: "check", title: "Safety check on this Mac" } as const;
  if (summary.install.state !== "ready")
    return { ...step, state: "todo", detail: "Runs by itself after installing" };
  switch (summary.sandbox) {
    case "passed":
      return { ...step, state: "done", detail: "Passed" };
    case "failed":
      return { ...step, state: "failed", detail: "Didn't pass, so ChatGPT stays off" };
    default:
      return { ...step, state: "doing", detail: "Making sure it can't reach your files…" };
  }
}

function signIn(summary: ChatgptSummary): ChatgptStep {
  const step = { id: "sign-in", title: "Sign in" } as const;
  if (summary.install.state !== "ready" || summary.sandbox !== "passed")
    return { ...step, state: "todo", detail: "With a code from ChatGPT" };
  switch (summary.state) {
    case "signed_in":
      return { ...step, state: "done", detail: "Signed in" };
    case "signing_in":
      return { ...step, state: "doing", detail: "Waiting for your account…" };
    case "expired":
      return { ...step, state: "ask", detail: "Your sign-in expired" };
    case "signed_out":
      return { ...step, state: "ask", detail: "With a code from ChatGPT" };
    default:
      return { ...step, state: "todo", detail: "With a code from ChatGPT" };
  }
}

// Install, then this Mac's safety check, then sign-in: the plan's setup as three steps.
export function chatgptSteps(summary: ChatgptSummary, starting: boolean): ChatgptStep[] {
  return [install(summary, starting), check(summary), signIn(summary)];
}

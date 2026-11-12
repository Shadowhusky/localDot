import type { CodexInstallFailure } from "@localdot/protocol";
import { t, tr } from "../i18n/index.ts";
import type { GlyphState } from "../ui/StatusGlyph.tsx";
import type { ChatgptSummary } from "./chatgpt-api.ts";

export const INSTALL_FAILURES: Record<CodexInstallFailure, string> = {
  unsupported_platform: tr("ChatGPT support is unavailable on this platform."),
  download_failed: tr("The download didn't finish. Check the connection and try again."),
  integrity_failed: tr("The download didn't pass its check. Try the download again."),
  unsafe_archive: tr("The download couldn't be installed safely. Try the download again."),
  storage_failed: tr("ChatGPT support couldn't be saved. Check free space and try again."),
  cancelled: tr("Installation was cancelled. You can install again when ready."),
};

export interface ChatgptStep {
  id: "install" | "check" | "sign-in";
  title: string;
  detail: string;
  state: GlyphState;
}

export const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function install(summary: ChatgptSummary, starting: boolean): ChatgptStep {
  const step = { id: "install", title: t`Install ChatGPT support` } as const;
  const value = summary.install;
  switch (value.state) {
    case "ready":
      return { ...step, state: "done", detail: t`Installed` };
    case "failed":
      return { ...step, state: "failed", detail: INSTALL_FAILURES[value.code] };
    case "verifying":
      return { ...step, state: "doing", detail: t`Checking the download…` };
    case "downloading":
      return {
        ...step,
        state: "doing",
        detail:
          value.totalBytes === undefined
            ? t`Downloading… ${megabytes(value.receivedBytes)}`
            : t`Downloading… ${megabytes(value.receivedBytes)} of ${megabytes(value.totalBytes)}`,
      };
    default:
      return starting
        ? { ...step, state: "doing", detail: t`Starting the download…` }
        : { ...step, state: "todo", detail: t`A one-time download` };
  }
}

function check(summary: ChatgptSummary): ChatgptStep {
  const step = { id: "check", title: t`Safety check on this Mac` } as const;
  if (summary.install.state !== "ready")
    return { ...step, state: "todo", detail: t`Runs by itself after installing` };
  switch (summary.sandbox) {
    case "passed":
      return { ...step, state: "done", detail: t`Passed` };
    case "failed":
      return { ...step, state: "failed", detail: t`Didn't pass, so ChatGPT stays off` };
    default:
      return { ...step, state: "doing", detail: t`Making sure it can't reach your files…` };
  }
}

function signIn(summary: ChatgptSummary): ChatgptStep {
  const step = { id: "sign-in", title: t`Sign in` } as const;
  if (summary.install.state !== "ready" || summary.sandbox !== "passed")
    return { ...step, state: "todo", detail: t`With a code from ChatGPT` };
  switch (summary.state) {
    case "signed_in":
      return { ...step, state: "done", detail: t`Signed in` };
    case "signing_in":
      return { ...step, state: "doing", detail: t`Waiting for your account…` };
    case "expired":
      return { ...step, state: "ask", detail: t`Your sign-in expired` };
    case "signed_out":
      return { ...step, state: "ask", detail: t`With a code from ChatGPT` };
    default:
      return { ...step, state: "todo", detail: t`With a code from ChatGPT` };
  }
}

// Install, then this Mac's safety check, then sign-in: the plan's setup as three steps.
export function chatgptSteps(summary: ChatgptSummary, starting: boolean): ChatgptStep[] {
  return [install(summary, starting), check(summary), signIn(summary)];
}

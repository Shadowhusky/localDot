import type { AppUpdateStatus } from "../../../../packages/protocol/src/app-update.ts";
import { tr } from "../i18n/index.ts";

// What an update goes through, as the person watching it sees it. The last is the page's own.
export const UPDATE_STAGES = [
  "check",
  "download",
  "verify",
  "images",
  "install",
  "restart",
  "reconnect",
] as const;
export type UpdateStage = (typeof UPDATE_STAGES)[number];

export const STAGE_NAMES: Record<UpdateStage, string> = {
  check: tr("Check for updates"),
  download: tr("Download"),
  verify: tr("Verify the download"),
  images: tr("Prepare the computer"),
  install: tr("Install"),
  restart: tr("Restart"),
  reconnect: tr("Reconnect"),
};

export interface UpdateView {
  status: AppUpdateStatus;
  // The request is on its way and the daemon hasn't answered yet.
  starting?: boolean;
  // Installing, and localDot has stopped answering while it restarts.
  restarting?: boolean;
  // It answers again as the new version, which the installer is still checking.
  reconnecting?: boolean;
}

// The stage under way, or null when no update is.
export function stageOf({ status, starting, restarting, reconnecting }: UpdateView) {
  if (reconnecting) return "reconnect";
  if (restarting) return "restart";
  switch (status.phase) {
    case "checking":
      return "check";
    case "downloading":
      return status.progress?.step === "verify" || status.progress?.step === "images"
        ? status.progress.step
        : "download";
    case "installing":
      return status.progress?.step === "restart" ? "restart" : "install";
    default:
      if (status.updating) return status.phase === "ready" ? "install" : "check";
      return starting ? "check" : null;
  }
}

// What failed, when something did: the error names it, and its progress says at which step.
export const failedStage = ({ error, progress }: AppUpdateStatus): UpdateStage | null =>
  error && progress ? progress.step : null;

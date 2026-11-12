import type {
  SpeechInstallJob,
  SpeechInstallStage,
  SpeechInstallStatus,
  SpeechTierId,
  SpeechTierView,
} from "../../../../packages/protocol/src/speech-install.ts";
import { t, tr } from "../i18n/index.ts";
import { modelLanguage } from "./language.ts";

const MB = 1024 ** 2;

export function sizeWords(bytes: number): string {
  return bytes >= 1024 * MB
    ? `${(bytes / (1024 * MB)).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / MB))} MB`;
}

export const hearsLanguage = (tier: Pick<SpeechTierView, "languages">, language: string) =>
  !tier.languages || tier.languages.includes(modelLanguage(language));

// What to preselect: the recommendation, unless the person's language needs another tier.
export function tierForLanguage(status: SpeechInstallStatus, language: string): SpeechTierId {
  const recommended = status.tiers.find((tier) => tier.id === status.recommended);
  if (recommended && hearsLanguage(recommended, language)) return status.recommended;
  return status.tiers.find((tier) => hearsLanguage(tier, language))?.id ?? status.recommended;
}

export const INSTALL_STAGES: readonly { stage: SpeechInstallStage; name: string }[] = [
  { stage: "checking", name: tr("Check free space") },
  { stage: "program", name: tr("Download the speech program") },
  { stage: "model", name: tr("Download the speech model") },
  { stage: "unpacking", name: tr("Check and unpack the files") },
  { stage: "testing", name: tr("Try it once") },
];

export function jobDetail(job: SpeechInstallJob): string | undefined {
  if (job.stage !== "program" && job.stage !== "model") return undefined;
  return t`${sizeWords(job.doneBytes)} of ${sizeWords(job.totalBytes)}`;
}

export const jobShare = (job: SpeechInstallJob) =>
  job.totalBytes > 0 ? Math.round((100 * job.doneBytes) / job.totalBytes) : 0;

// A few words on how speech stands, for a summary row.
export function speechSummary(status: SpeechInstallStatus | null): string {
  if (!status) return "";
  const { job, installed, handInstalled, tiers } = status;
  if (job?.state === "running") {
    const name = tiers.find((tier) => tier.id === job.tier)?.name ?? job.tier;
    return `${name}, ${jobShare(job)}%`;
  }
  if (job?.state === "failed") return t`Couldn't finish`;
  if (installed) return installed.damaged ? t`Needs reinstalling` : installed.name;
  if (handInstalled) return t`Your own Whisper`;
  return t`Not set up`;
}

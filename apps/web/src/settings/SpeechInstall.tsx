import { type ReactNode, useState } from "react";
import type {
  SpeechInstallJob,
  SpeechInstallStatus,
  SpeechTierId,
  SpeechTierView,
} from "../../../../packages/protocol/src/speech-install.ts";
import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Progress } from "../ui/Progress.tsx";
import { RadioCards } from "../ui/RadioCards.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import {
  hearsLanguage,
  INSTALL_STAGES,
  jobDetail,
  sizeWords,
  tierForLanguage,
} from "../voice/speech-words.ts";
import type { SpeechInstallControl } from "../voice/useSpeechInstall.ts";

// Its size, the memory it needs and how quick it is, then anything honest to say about this computer.
function tierLine(tier: SpeechTierView, language: string) {
  const facts = t`${sizeWords(tier.downloadBytes)} download · ${sizeWords(tier.memoryBytes)} of memory · ${tier.speed}`;
  const warning = !hearsLanguage(tier, language)
    ? t`Doesn't hear the language you chose, so your browser's speech is used for that instead.`
    : tier.warning;
  return (
    <>
      {tier.summary}
      <span className="speech-tier-facts">{facts}</span>
      {warning && <span className="speech-tier-warning">{warning}</span>}
    </>
  );
}

export function SpeechTierPicker({
  status,
  language,
  value,
  onChange,
  roomy = false,
}: {
  status: SpeechInstallStatus;
  language: string;
  value: SpeechTierId;
  onChange(tier: SpeechTierId): void;
  roomy?: boolean;
}) {
  return (
    <RadioCards
      className={roomy ? "onboarding-choices" : "speech-tiers"}
      aria-label={t`Speech model`}
      mark="end"
      roomy={roomy}
      value={value}
      onValueChange={(next) => onChange(next as SpeechTierId)}
      options={status.tiers.map((tier) => ({
        value: tier.id,
        label: tier.name,
        tag: tier.id === status.recommended ? t`Recommended` : undefined,
        description: tierLine(tier, language),
      }))}
    />
  );
}

// How far it has come, in stages, and the honest reason if it stopped.
export function SpeechProgress({ job, children }: { job: SpeechInstallJob; children: ReactNode }) {
  const failed = job.state === "failed";
  const at = INSTALL_STAGES.findIndex(({ stage }) => stage === job.stage);
  const downloading = job.stage === "program" || job.stage === "model";
  const detail = jobDetail(job);
  return (
    <div className="speech-progress">
      {failed ? (
        <p className="speech-progress-error" role="alert">
          {job.message ?? t`The speech model couldn't be installed. Try again.`}
        </p>
      ) : (
        <>
          <Progress
            label={t`Speech download`}
            value={downloading ? job.doneBytes : undefined}
            max={job.totalBytes || 1}
            valueText={detail}
          />
          {detail && <span className="speech-progress-detail">{detail}</span>}
        </>
      )}
      <ol className="settings-steps settings-update-steps" aria-label={t`Install steps`}>
        {INSTALL_STAGES.map(({ stage, name }, index) => {
          const state = index < at ? "done" : index === at ? (failed ? "failed" : "doing") : "todo";
          return (
            <li key={stage} className="settings-step" data-state={state}>
              <StatusGlyph state={state} className="settings-step-glyph" />
              <span className="settings-step-text">
                <span className="settings-step-name">{name}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <span className="speech-actions">{children}</span>
    </div>
  );
}

// Settings → Voice: what's on the computer, what can be installed, and how an install is going.
export function SpeechInstallPanel({
  speech,
  language,
}: {
  speech: SpeechInstallControl;
  language: string;
}) {
  const { status, pending, failure } = speech;
  const [changing, setChanging] = useState(false);
  const [chosen, setChosen] = useState<SpeechTierId | null>(null);
  const [removing, setRemoving] = useState(false);
  if (!status) return null;
  const mac = status.host.computer === "Mac";
  const { job, installed, handInstalled } = status;
  const running = job?.state === "running";
  const failedJob = job?.state === "failed" ? job : null;
  const jobTier = job && status.tiers.find((tier) => tier.id === job.tier);
  const installedTier = status.tiers.find((tier) => tier.id === installed?.tier);
  const preselected = chosen ?? installed?.tier ?? tierForLanguage(status, language);
  const offerPicker = status.supported && !job && (changing || !installed || installed.damaged);
  const choice = status.tiers.find((tier) => tier.id === preselected);
  const ownWhisper = (own: NonNullable<SpeechInstallStatus["handInstalled"]>) =>
    [
      own.model,
      own.englishOnly && t`English only`,
      status.using === "installed"
        ? t`You set this up, so localDot only reads it and never changes or removes it. Not in use while the model above is installed.`
        : t`You set this up, so localDot only reads it and never changes or removes it.`,
    ]
      .filter(Boolean)
      .join(" · ");
  const installedDetail = (diskBytes: number) => {
    const size = sizeWords(diskBytes);
    if (status.using === "hand-installed")
      return t`Installed by localDot · ${size} · Not in use: LOCALDOT_SPEECH_MODEL names another model`;
    if (installedTier && !hearsLanguage(installedTier, language))
      return t`Installed by localDot · ${size} · Doesn't hear the language you chose, so your browser's speech is used for that`;
    return t`Installed by localDot · ${size}`;
  };
  const removeDescription = () => {
    const size = sizeWords(installed?.diskBytes ?? 0);
    if (mac)
      return handInstalled
        ? t`This frees ${size} on your Mac. You can install it again any time. Your own Whisper stays where it is.`
        : t`This frees ${size} on your Mac. You can install it again any time.`;
    return handInstalled
      ? t`This frees ${size} on your computer. You can install it again any time. Your own Whisper stays where it is.`
      : t`This frees ${size} on your computer. You can install it again any time.`;
  };
  const jobName = jobTier?.name ?? t`speech`;
  const start = (tier: SpeechTierId) => {
    void speech.install(tier).then((started) => {
      if (started) setChanging(false);
    });
  };
  return (
    <div className="speech-install">
      <GroupHead title={mac ? t`Speech model on your Mac` : t`Speech model on your computer`} />
      <Group>
        {installed && (
          <GroupRow
            leading={<IconTile icon="mic" />}
            label={installed.name}
            detail={
              installed.reason === "outdated"
                ? t`It was installed by another version of localDot, so this one won't run it. Install it again to use it.`
                : installed.damaged
                  ? t`Its files changed, or something was added beside them, so localDot won't run them. Install it again to fix this.`
                  : installedDetail(installed.diskBytes)
            }
            trailing={
              !job && (
                <span className="speech-actions">
                  {!installed.damaged && (
                    <Button
                      size="sm"
                      aria-expanded={changing}
                      onClick={() => setChanging((now) => !now)}
                    >
                      {changing ? t`Keep this` : t`Change`}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="quiet"
                    busy={pending === "remove"}
                    onClick={() => setRemoving(true)}
                  >
                    {t`Remove`}
                  </Button>
                </span>
              )
            }
          />
        )}
        {handInstalled && (
          <GroupRow
            leading={<IconTile icon="mic" />}
            label={t`Your own Whisper`}
            detail={ownWhisper(handInstalled)}
          />
        )}
        {job && (
          <GroupRow
            leading={<IconTile icon="download" />}
            label={
              <span role="status">
                {running
                  ? mac
                    ? t`Installing ${jobName} on your Mac…`
                    : t`Installing ${jobName} on your computer…`
                  : t`Couldn't install ${jobName}`}
              </span>
            }
            detail={
              running
                ? mac
                  ? t`Your Mac does this. You can close this page.`
                  : t`Your computer does this. You can close this page.`
                : undefined
            }
          >
            <SpeechProgress job={job}>
              {failedJob && (
                <Button
                  size="sm"
                  busy={pending === "install"}
                  onClick={() => start(failedJob.tier)}
                >
                  {t`Retry`}
                </Button>
              )}
              <Button
                size="sm"
                variant={failedJob ? "quiet" : undefined}
                busy={pending === "cancel"}
                onClick={speech.cancel}
              >
                {failedJob ? t`Discard` : t`Cancel`}
              </Button>
            </SpeechProgress>
          </GroupRow>
        )}
        {!installed && !handInstalled && !job && (
          <GroupRow
            leading={<IconTile icon="mic" />}
            label={status.supported ? t`Not installed` : t`Not available here`}
            detail={
              status.supported
                ? mac
                  ? t`Install a speech model so dictating works the same in every browser, and your voice stays on your Mac.`
                  : t`Install a speech model so dictating works the same in every browser, and your voice stays on your computer.`
                : t`There's no speech program for this system yet. Your browser's speech is used instead.`
            }
          />
        )}
      </Group>
      {failure && <GroupNote role="alert">{failure}</GroupNote>}
      {offerPicker && (
        <>
          <SpeechTierPicker
            status={status}
            language={language}
            value={preselected}
            onChange={setChosen}
          />
          <div className="speech-install-action">
            <Button
              variant="primary"
              size="sm"
              icon="download"
              busy={pending === "install"}
              disabledReason={
                installed?.tier === preselected && !installed.damaged
                  ? t`This one is already installed`
                  : undefined
              }
              onClick={() => start(preselected)}
            >
              {choice ? t`Install ${choice.name} · ${sizeWords(choice.downloadBytes)}` : t`Install`}
            </Button>
            <span className="speech-install-free">
              {mac
                ? t`${sizeWords(status.freeBytes)} free on your Mac`
                : t`${sizeWords(status.freeBytes)} free on your computer`}
            </span>
          </div>
          {choice && <GroupNote>{choice.credit}</GroupNote>}
        </>
      )}
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={t`Remove the speech model?`}
        description={removeDescription()}
      >
        <Button onClick={() => setRemoving(false)}>{t`Keep it`}</Button>
        <Button
          variant="primary"
          onClick={() => {
            setRemoving(false);
            speech.remove();
          }}
        >
          {t`Remove`}
        </Button>
      </Dialog>
    </div>
  );
}

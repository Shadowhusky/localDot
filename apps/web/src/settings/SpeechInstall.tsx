import { type ReactNode, useState } from "react";
import type {
  SpeechInstallJob,
  SpeechInstallStatus,
  SpeechTierId,
  SpeechTierView,
} from "../../../../packages/protocol/src/speech-install.ts";
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
  const facts = `${sizeWords(tier.downloadBytes)} download · ${sizeWords(tier.memoryBytes)} of memory · ${tier.speed}`;
  const warning = !hearsLanguage(tier, language)
    ? `Doesn't hear the language you chose, so your browser's speech is used for that instead.`
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
      aria-label="Speech model"
      mark="end"
      roomy={roomy}
      value={value}
      onValueChange={(next) => onChange(next as SpeechTierId)}
      options={status.tiers.map((tier) => ({
        value: tier.id,
        label: tier.name,
        tag: tier.id === status.recommended ? "Recommended" : undefined,
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
          {job.message ?? "The speech model couldn't be installed. Try again."}
        </p>
      ) : (
        <>
          <Progress
            label="Speech download"
            value={downloading ? job.doneBytes : undefined}
            max={job.totalBytes || 1}
            valueText={detail}
          />
          {detail && <span className="speech-progress-detail">{detail}</span>}
        </>
      )}
      <ol className="settings-steps settings-update-steps" aria-label="Install steps">
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
  const computer = status.host.computer;
  const { job, installed, handInstalled } = status;
  const running = job?.state === "running";
  const failedJob = job?.state === "failed" ? job : null;
  const jobTier = job && status.tiers.find((tier) => tier.id === job.tier);
  const installedTier = status.tiers.find((tier) => tier.id === installed?.tier);
  const preselected = chosen ?? installed?.tier ?? tierForLanguage(status, language);
  const offerPicker = status.supported && !job && (changing || !installed || installed.damaged);
  const choice = status.tiers.find((tier) => tier.id === preselected);
  const start = (tier: SpeechTierId) => {
    void speech.install(tier).then((started) => {
      if (started) setChanging(false);
    });
  };
  return (
    <div className="speech-install">
      <GroupHead title={`Speech model on your ${computer}`} />
      <Group>
        {installed && (
          <GroupRow
            leading={<IconTile icon="mic" />}
            label={installed.name}
            detail={
              installed.damaged
                ? "Its files changed since they were installed, so localDot won't run them. Install it again to fix this."
                : `Installed by localDot · ${sizeWords(installed.diskBytes)}${
                    status.using === "hand-installed"
                      ? " · Not in use: LOCALDOT_SPEECH_MODEL names another model"
                      : installedTier && !hearsLanguage(installedTier, language)
                        ? " · Doesn't hear the language you chose, so your browser's speech is used for that"
                        : ""
                  }`
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
                      {changing ? "Keep this" : "Change"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="quiet"
                    busy={pending === "remove"}
                    onClick={() => setRemoving(true)}
                  >
                    Remove
                  </Button>
                </span>
              )
            }
          />
        )}
        {handInstalled && (
          <GroupRow
            leading={<IconTile icon="mic" />}
            label="Your own Whisper"
            detail={`${handInstalled.model}${handInstalled.englishOnly ? " · English only" : ""} · You set this up, so localDot only reads it and never changes or removes it.${
              status.using === "installed" ? " Not in use while the model above is installed." : ""
            }`}
          />
        )}
        {job && (
          <GroupRow
            leading={<IconTile icon="download" />}
            label={
              <span role="status">
                {running
                  ? `Installing ${jobTier?.name ?? "speech"} on your ${computer}…`
                  : `Couldn't install ${jobTier?.name ?? "speech"}`}
              </span>
            }
            detail={running ? `Your ${computer} does this. You can close this page.` : undefined}
          >
            <SpeechProgress job={job}>
              {failedJob && (
                <Button
                  size="sm"
                  busy={pending === "install"}
                  onClick={() => start(failedJob.tier)}
                >
                  Retry
                </Button>
              )}
              <Button
                size="sm"
                variant={failedJob ? "quiet" : undefined}
                busy={pending === "cancel"}
                onClick={speech.cancel}
              >
                {failedJob ? "Discard" : "Cancel"}
              </Button>
            </SpeechProgress>
          </GroupRow>
        )}
        {!installed && !handInstalled && !job && (
          <GroupRow
            leading={<IconTile icon="mic" />}
            label={status.supported ? "Not installed" : "Not available here"}
            detail={
              status.supported
                ? `Install a speech model so dictating works the same in every browser, and your voice stays on your ${computer}.`
                : "There's no speech program for this system yet. Your browser's speech is used instead."
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
                  ? "This one is already installed"
                  : undefined
              }
              onClick={() => start(preselected)}
            >
              {choice ? `Install ${choice.name} · ${sizeWords(choice.downloadBytes)}` : "Install"}
            </Button>
            <span className="speech-install-free">
              {`${sizeWords(status.freeBytes)} free on your ${computer}`}
            </span>
          </div>
          {choice && <GroupNote>{choice.credit}</GroupNote>}
        </>
      )}
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title="Remove the speech model?"
        description={`This frees ${sizeWords(installed?.diskBytes ?? 0)} on your ${computer}. You can install it again any time.${
          handInstalled ? " Your own Whisper stays where it is." : ""
        }`}
      >
        <Button onClick={() => setRemoving(false)}>Keep it</Button>
        <Button
          variant="primary"
          onClick={() => {
            setRemoving(false);
            speech.remove();
          }}
        >
          Remove
        </Button>
      </Dialog>
    </div>
  );
}

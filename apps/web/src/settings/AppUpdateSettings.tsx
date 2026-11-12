import { useId, useState } from "react";
import type {
  AppUpdateHolder,
  AppUpdateProgress,
  ReleaseNote,
} from "../../../../packages/protocol/src/app-update.ts";
import { SafeMarkdown } from "../agent/SafeMarkdown.tsx";
import { t, tr } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Progress } from "../ui/Progress.tsx";
import { Switch } from "../ui/Switch.tsx";
import { StableText } from "./StableText.tsx";
import { UpdateSteps } from "./UpdateSteps.tsx";
import {
  failedStage,
  STAGE_NAMES,
  stageOf,
  UPDATE_STAGES,
  type UpdateStage,
} from "./update-stage.ts";
import type { AppUpdateControl } from "./useAppUpdate.ts";

const shown = (version: string) => (version.length === 40 ? version.slice(0, 8) : version);

// What holds the update back, each named with what it is doing.
function Holders({ holders }: { holders: readonly AppUpdateHolder[] }) {
  return (
    <ul className="settings-update-holders" aria-label={t`Holding the update back`}>
      {holders.map((holder, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: another dot's tasks have no task id.
        <li key={holder.sessionId ?? `other-${index}`}>
          <span className="settings-update-holder">{holder.title ?? t`Untitled task`}</span>
          {holder.state && <span className="settings-update-detail"> · {holder.state}</span>}
        </li>
      ))}
    </ul>
  );
}

function UpdateProgress({ progress }: { progress: AppUpdateProgress }) {
  return (
    <div className="settings-update-progress">
      <Progress
        label={t`Update progress`}
        value={progress.value ?? undefined}
        valueText={progress.detail ?? undefined}
      />
      {progress.detail && <span className="settings-update-detail">{progress.detail}</span>}
    </div>
  );
}

function AppUpdateSteps({ at, failed }: { at: UpdateStage; failed: boolean }) {
  return <UpdateSteps stages={UPDATE_STAGES} names={STAGE_NAMES} at={at} failed={failed} />;
}

// What failed, in one sentence, over the steps the update went through.
function UpdateFailure({ error, failed }: { error: string; failed: UpdateStage }) {
  return (
    <div className="settings-update-progress">
      <p className="settings-update-error">{error}</p>
      <AppUpdateSteps at={failed} failed />
    </div>
  );
}

// What's going on while localDot restarts and this page has nothing else to go on.
export function restartWords(update: AppUpdateControl, version: string | null) {
  if (update.wait === "lost")
    return t`localDot hasn't come back. On the computer running it, run localdot up. This page keeps trying.`;
  if (update.wait === "slow") return t`This is taking longer than usual. This page keeps trying.`;
  if (update.reconnecting) return version ? t`Checking localDot ${version}` : t`Checking localDot`;
  return version ? t`Starting localDot ${version}` : t`Reconnecting to localDot`;
}

// The newest version's notes open, any it skips folded under them.
function ReleaseNotes({ notes }: { notes: ReleaseNote[] }) {
  const id = useId();
  const [first, ...older] = notes;
  if (!first) return null;
  return (
    <section className="settings-release-notes" aria-labelledby={id}>
      <GroupHead id={id} title={t`What's new in ${first.version}`} />
      <Group>
        <div className="ui-group-row">
          <SafeMarkdown compact text={first.markdown} />
        </div>
        {older.map((note) => (
          <div key={note.version} className="ui-group-row">
            <Disclosure inline summary={t`What's new in ${note.version}`}>
              <SafeMarkdown compact text={note.markdown} />
            </Disclosure>
          </div>
        ))}
      </Group>
    </section>
  );
}

const UNSUPPORTED = {
  "source-checkout": {
    title: tr("This copy runs from source"),
    detail: tr(
      "It updates from its Git checkout, not from here: pull, rebuild, then restart localDot.",
    ),
  },
  "install-record": {
    title: tr("Update localDot manually"),
    detail: tr("This copy can’t update itself. Run localdot update in Terminal."),
  },
};

export function AppUpdateSettings({ update }: { update: AppUpdateControl }) {
  const { status, busy } = update;
  const [confirm, setConfirm] = useState(false);
  if (!status) return update.error ? <GroupNote>{update.error}</GroupNote> : null;
  // The update someone asked for, waiting on a task before it installs.
  const held = status.updating && status.phase !== "installing" ? status.waiting : null;
  // A waiting update is at no stage: it starts once the way is clear.
  const stage = held ? null : stageOf({ ...update, status });
  const failed = stage || held ? null : failedStage(status);
  const version = status.availableVersion;
  const displayVersion = version && shown(version);
  const unsupported = UNSUPPORTED[status.unsupported ?? "install-record"];
  const holding = status.holders.length > 0;
  const stoppable = status.holders.some((each) => each.sessionId);
  const installingTitle = displayVersion
    ? t`Installing localDot ${displayVersion}…`
    : t`Installing localDot…`;
  const downloadingTitle = displayVersion
    ? t`Downloading localDot ${displayVersion}…`
    : t`Downloading localDot…`;
  const restartingTitle = t`Restarting localDot…`;
  const reconnectingTitle = t`Reconnecting to localDot…`;
  const checkingTitle = t`Checking for updates…`;
  const unfinishedTitle = t`The update didn't finish`;
  const waitingTitle = t`The update waits for your task`;
  const upToDateTitle = t`localDot is up to date`;
  const checkTitle = t`Check for a new version`;
  const readyTitle = t`localDot ${displayVersion ?? ""} is ready`;
  const availableTitle = t`localDot ${displayVersion ?? ""} is available`;
  const title = !status.supported
    ? unsupported.title
    : stage === "check"
      ? checkingTitle
      : stage === "download" || stage === "verify" || stage === "images"
        ? downloadingTitle
        : stage === "install"
          ? installingTitle
          : stage === "restart"
            ? restartingTitle
            : stage === "reconnect"
              ? reconnectingTitle
              : held
                ? waitingTitle
                : failed
                  ? unfinishedTitle
                  : version
                    ? status.phase === "ready"
                      ? readyTitle
                      : availableTitle
                    : status.checkedAt
                      ? upToDateTitle
                      : checkTitle;
  const titles = [
    restartingTitle,
    reconnectingTitle,
    checkingTitle,
    unfinishedTitle,
    waitingTitle,
    upToDateTitle,
    checkTitle,
    downloadingTitle,
    installingTitle,
    ...(version ? [readyTitle, availableTitle] : []),
  ];
  const updateNow = t`Update now`;
  const retry = t`Retry`;
  const checkNow = t`Check now`;
  const notChecked = t`Not checked yet`;
  // Once localDot stops answering, the restart is under way.
  const progress: AppUpdateProgress | null =
    stage === "restart" || stage === "reconnect"
      ? {
          step: "restart",
          value: status.progress?.value ?? null,
          detail:
            update.restarting || update.reconnecting
              ? restartWords(update, displayVersion)
              : (status.progress?.detail ?? null),
        }
      : status.progress;
  const canUpdate = !!version || status.phase === "ready";
  return (
    <div>
      <GroupHead title={t`localDot updates`} />
      <Group>
        <GroupRow
          leading={<IconTile icon="download" />}
          label={
            <span role="status">
              {status.supported ? <StableText choices={titles} value={title} /> : title}
            </span>
          }
          detail={
            status.supported
              ? status.currentVersion.length === 40
                ? t`Installed build ${shown(status.currentVersion)}`
                : t`Installed version ${status.currentVersion}`
              : unsupported.detail
          }
          trailing={
            status.supported && (
              <Button
                size="sm"
                busy={busy || !!stage}
                onClick={failed ? update.update : canUpdate ? () => setConfirm(true) : update.check}
              >
                <StableText
                  choices={[updateNow, retry, checkNow]}
                  value={failed ? retry : canUpdate ? updateNow : checkNow}
                />
              </Button>
            )
          }
        >
          {held ? (
            <div className="settings-update-progress">
              <p className="settings-update-detail">{held}</p>
              {holding && <Holders holders={status.holders} />}
              <div className="settings-update-actions">
                {stoppable && (
                  <Button size="sm" variant="secondary" onClick={() => setConfirm(true)}>
                    {t`Stop all and update`}
                  </Button>
                )}
                <Button size="sm" variant="quiet" onClick={update.cancel}>
                  {t`Cancel update`}
                </Button>
              </div>
            </div>
          ) : failed && status.error ? (
            <UpdateFailure error={status.error} failed={failed} />
          ) : (
            <>
              {progress && <UpdateProgress progress={progress} />}
              {stage && (
                <div className="settings-update-progress">
                  <AppUpdateSteps at={stage} failed={false} />
                </div>
              )}
            </>
          )}
        </GroupRow>
        {status.supported && (
          <>
            <Switch
              className="ui-group-row"
              label={t`Check automatically`}
              description={t`Quietly checks a few times a day`}
              checked={status.preferences.automaticChecks}
              disabledReason={busy ? t`Saving…` : undefined}
              onCheckedChange={(on) =>
                update.preferences({ ...status.preferences, automaticChecks: on })
              }
            />
            <Switch
              className="ui-group-row"
              label={t`Download updates`}
              description={t`Prepares updates in the background`}
              checked={status.preferences.automaticDownloads}
              disabledReason={busy ? t`Saving…` : undefined}
              onCheckedChange={(on) =>
                update.preferences({ ...status.preferences, automaticDownloads: on })
              }
            />
            {status.installOnLaunchSupported && (
              <Switch
                className="ui-group-row"
                label={t`Install at next launch`}
                description={t`Only after localDot has been fully stopped`}
                checked={status.preferences.installOnLaunch}
                disabledReason={busy ? t`Saving…` : undefined}
                onCheckedChange={(on) =>
                  update.preferences({ ...status.preferences, installOnLaunch: on })
                }
              />
            )}
          </>
        )}
      </Group>
      {(update.error || (status.error && !failed)) && (
        <GroupNote>{update.error ?? status.error}</GroupNote>
      )}
      {status.phase === "ready" && !failed && !stage && !held && (
        <GroupNote>
          {status.currentVersion.length === 40
            ? t`The update is downloaded. Building it may take a few minutes.`
            : t`The update is downloaded. Updating restarts localDot once.`}
        </GroupNote>
      )}
      {status.supported && (
        <GroupNote>
          <StableText
            choices={[t`Last checked ${new Date().toLocaleString()}`, notChecked]}
            value={
              status.checkedAt !== null
                ? t`Last checked ${new Date(status.checkedAt).toLocaleString()}`
                : notChecked
            }
          />
        </GroupNote>
      )}
      <ReleaseNotes notes={status.notes} />
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={holding ? t`Stop these and update?` : t`Update localDot now?`}
        description={
          holding
            ? t`Updating restarts localDot, which ends what's below. Stop them all and update now, or let the update wait until they finish. Your computer, files and sign-ins stay.`
            : t`localDot restarts to install the update, and this page reconnects by itself. It usually takes about a minute. Your computer, files and sign-ins stay.`
        }
        body={holding ? <Holders holders={status.holders} /> : undefined}
      >
        <Button variant="quiet" onClick={() => setConfirm(false)}>
          {t`Later`}
        </Button>
        {holding && !held && (
          <Button
            variant="secondary"
            onClick={() => {
              setConfirm(false);
              update.update();
            }}
          >
            {t`Update when they finish`}
          </Button>
        )}
        <Button
          variant={holding && stoppable ? "destructive" : "primary"}
          onClick={() => {
            setConfirm(false);
            if (holding && stoppable) update.stopAndUpdate();
            else update.update();
          }}
        >
          {holding && stoppable ? t`Stop all and update` : updateNow}
        </Button>
      </Dialog>
    </div>
  );
}

// While localDot installs and restarts, nothing else on the page can act, so it says what is going
// on over everything, on every device. It can be put aside; Settings keeps following the update.
export function AppUpdateOverlay({ update }: { update: AppUpdateControl }) {
  const { status } = update;
  const [hidden, setHidden] = useState(false);
  const underway = !!status?.supported && (status.phase === "installing" || update.restarting);
  if (!underway && hidden) setHidden(false);
  if (!status) return null;
  const stage = stageOf({ ...update, status }) ?? "install";
  const version = status.availableVersion ?? status.currentVersion;
  const name = shown(version);
  const line =
    update.restarting || update.reconnecting
      ? restartWords(update, name)
      : (status.progress?.detail ?? t`Installing localDot ${name}`);
  return (
    <Dialog
      open={underway && !hidden}
      onClose={() => setHidden(true)}
      title={t`Updating localDot to ${name}`}
      body={
        <div className="settings-update-overlay" role="status">
          <Progress
            label={t`Update progress`}
            value={status.progress?.value ?? undefined}
            valueText={line}
          />
          <p className="settings-update-detail">{line}</p>
          <AppUpdateSteps at={stage} failed={false} />
        </div>
      }
    >
      <Button variant="quiet" onClick={() => setHidden(true)}>
        {t`Hide`}
      </Button>
    </Dialog>
  );
}

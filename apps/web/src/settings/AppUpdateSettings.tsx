import { useId, useState } from "react";
import type {
  AppUpdateHolder,
  AppUpdateProgress,
  ReleaseNote,
} from "../../../../packages/protocol/src/app-update.ts";
import { SafeMarkdown } from "../agent/SafeMarkdown.tsx";
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
    <ul className="settings-update-holders" aria-label="Holding the update back">
      {holders.map((holder, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: another dot's tasks have no task id.
        <li key={holder.sessionId ?? `other-${index}`}>
          <span className="settings-update-holder">{holder.title ?? "Untitled task"}</span>
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
        label="Update progress"
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
    return "localDot hasn't come back. On the computer running it, run localdot up. This page keeps trying.";
  if (update.wait === "slow") return "This is taking longer than usual. This page keeps trying.";
  if (update.reconnecting) return `Checking localDot ${version ?? ""}`.trim();
  return version ? `Starting localDot ${version}` : "Reconnecting to localDot";
}

// The newest version's notes open, any it skips folded under them.
function ReleaseNotes({ notes }: { notes: ReleaseNote[] }) {
  const id = useId();
  const [first, ...older] = notes;
  if (!first) return null;
  return (
    <section className="settings-release-notes" aria-labelledby={id}>
      <GroupHead id={id} title={`What's new in ${first.version}`} />
      <Group>
        <div className="ui-group-row">
          <SafeMarkdown compact text={first.markdown} />
        </div>
        {older.map((note) => (
          <div key={note.version} className="ui-group-row">
            <Disclosure inline summary={`What's new in ${note.version}`}>
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
    title: "This copy runs from source",
    detail:
      "It updates from its Git checkout, not from here: pull, rebuild, then restart localDot.",
  },
  "install-record": {
    title: "Update localDot manually",
    detail: "This copy can’t update itself. Run localdot update in Terminal.",
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
  const installingTitle = `Installing localDot${displayVersion ? ` ${displayVersion}` : ""}…`;
  const downloadingTitle = `Downloading localDot${displayVersion ? ` ${displayVersion}` : ""}…`;
  const title = !status.supported
    ? unsupported.title
    : stage === "check"
      ? "Checking for updates…"
      : stage === "download" || stage === "verify" || stage === "images"
        ? downloadingTitle
        : stage === "install"
          ? installingTitle
          : stage === "restart"
            ? "Restarting localDot…"
            : stage === "reconnect"
              ? "Reconnecting to localDot…"
              : held
                ? "The update waits for your task"
                : failed
                  ? "The update didn't finish"
                  : version
                    ? `localDot ${displayVersion} ${status.phase === "ready" ? "is ready" : "is available"}`
                    : status.checkedAt
                      ? "localDot is up to date"
                      : "Check for a new version";
  const titles = [
    "Restarting localDot…",
    "Reconnecting to localDot…",
    "Checking for updates…",
    "The update didn't finish",
    "The update waits for your task",
    "localDot is up to date",
    "Check for a new version",
    downloadingTitle,
    installingTitle,
    ...(version
      ? [`localDot ${displayVersion} is ready`, `localDot ${displayVersion} is available`]
      : []),
  ];
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
      <GroupHead title="localDot updates" />
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
              ? `Installed ${status.currentVersion.length === 40 ? `build ${shown(status.currentVersion)}` : `version ${status.currentVersion}`}`
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
                  choices={["Update now", "Retry", "Check now"]}
                  value={failed ? "Retry" : canUpdate ? "Update now" : "Check now"}
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
                    Stop all and update
                  </Button>
                )}
                <Button size="sm" variant="quiet" onClick={update.cancel}>
                  Cancel update
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
              label="Check automatically"
              description="Quietly checks a few times a day"
              checked={status.preferences.automaticChecks}
              disabledReason={busy ? "Saving…" : undefined}
              onCheckedChange={(on) =>
                update.preferences({ ...status.preferences, automaticChecks: on })
              }
            />
            <Switch
              className="ui-group-row"
              label="Download updates"
              description="Prepares updates in the background"
              checked={status.preferences.automaticDownloads}
              disabledReason={busy ? "Saving…" : undefined}
              onCheckedChange={(on) =>
                update.preferences({ ...status.preferences, automaticDownloads: on })
              }
            />
            {status.installOnLaunchSupported && (
              <Switch
                className="ui-group-row"
                label="Install at next launch"
                description="Only after localDot has been fully stopped"
                checked={status.preferences.installOnLaunch}
                disabledReason={busy ? "Saving…" : undefined}
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
            ? "The update is downloaded. Building it may take a few minutes."
            : "The update is downloaded. Updating restarts localDot once."}
        </GroupNote>
      )}
      {status.supported && (
        <GroupNote>
          <StableText
            choices={[`Last checked ${new Date().toLocaleString()}`, "Not checked yet"]}
            value={
              status.checkedAt !== null
                ? `Last checked ${new Date(status.checkedAt).toLocaleString()}`
                : "Not checked yet"
            }
          />
        </GroupNote>
      )}
      <ReleaseNotes notes={status.notes} />
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={holding ? "Stop these and update?" : "Update localDot now?"}
        description={
          holding
            ? "Updating restarts localDot, which ends what's below. Stop them all and update now, or let the update wait until they finish. Your computer, files and sign-ins stay."
            : "localDot restarts to install the update, and this page reconnects by itself. It usually takes about a minute. Your computer, files and sign-ins stay."
        }
        body={holding ? <Holders holders={status.holders} /> : undefined}
      >
        <Button variant="quiet" onClick={() => setConfirm(false)}>
          Later
        </Button>
        {holding && !held && (
          <Button
            variant="secondary"
            onClick={() => {
              setConfirm(false);
              update.update();
            }}
          >
            Update when they finish
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
          {holding && stoppable ? "Stop all and update" : "Update now"}
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
      : (status.progress?.detail ?? `Installing localDot ${name}`);
  return (
    <Dialog
      open={underway && !hidden}
      onClose={() => setHidden(true)}
      title={`Updating localDot to ${name}`}
      body={
        <div className="settings-update-overlay" role="status">
          <Progress
            label="Update progress"
            value={status.progress?.value ?? undefined}
            valueText={line}
          />
          <p className="settings-update-detail">{line}</p>
          <AppUpdateSteps at={stage} failed={false} />
        </div>
      }
    >
      <Button variant="quiet" onClick={() => setHidden(true)}>
        Hide
      </Button>
    </Dialog>
  );
}

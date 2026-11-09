import { useId, useState } from "react";
import type {
  AppUpdateProgress,
  ReleaseNote,
} from "../../../../packages/protocol/src/app-update.ts";
import { SafeMarkdown } from "../agent/SafeMarkdown.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Progress } from "../ui/Progress.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { Switch } from "../ui/Switch.tsx";
import { StableText } from "./StableText.tsx";
import {
  failedStage,
  STAGE_NAMES,
  stageOf,
  UPDATE_STAGES,
  type UpdateStage,
} from "./update-stage.ts";
import type { AppUpdateControl } from "./useAppUpdate.ts";

const shown = (version: string) => (version.length === 40 ? version.slice(0, 8) : version);

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

// The steps of the update, those behind it done and the one under way or failed marked.
function UpdateSteps({ at, failed }: { at: UpdateStage; failed: boolean }) {
  const index = UPDATE_STAGES.indexOf(at);
  return (
    <ol className="settings-steps settings-update-steps" aria-label="Update steps">
      {UPDATE_STAGES.map((stage, i) => {
        const state = i < index ? "done" : i > index ? "todo" : failed ? "failed" : "doing";
        return (
          <li
            key={stage}
            className="settings-step"
            data-state={state}
            aria-current={state === "doing" ? "step" : undefined}
          >
            <StatusGlyph state={state} className="settings-step-glyph" />
            <span className="settings-step-text">
              <span className="settings-step-name">{STAGE_NAMES[stage]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// What failed, in one sentence, over the steps the update went through.
function UpdateFailure({ error, failed }: { error: string; failed: UpdateStage }) {
  return (
    <div className="settings-update-progress">
      <p className="settings-update-error">{error}</p>
      <UpdateSteps at={failed} failed />
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
  const stage = stageOf({ ...update, status });
  const failed = stage ? null : failedStage(status);
  const version = status.availableVersion;
  const displayVersion = version && shown(version);
  const unsupported = UNSUPPORTED[status.unsupported ?? "install-record"];
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
          {failed && status.error ? (
            <UpdateFailure error={status.error} failed={failed} />
          ) : (
            <>
              {progress && <UpdateProgress progress={progress} />}
              {stage && (
                <div className="settings-update-progress">
                  <UpdateSteps at={stage} failed={false} />
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
      {status.phase === "ready" && !failed && !stage && (
        <GroupNote>
          <StableText
            choices={[
              "The source update is downloaded. Update when you’re ready; building it may take a few minutes.",
              "The update is downloaded. Updating restarts localDot once.",
              "Ready for your next launch. Update now when you’re finished, or leave it for after you quit localDot. Closing this browser tab does not quit the app.",
              "Your download is saved. Turn on Install at next launch when you’re ready to update.",
            ]}
            value={
              status.currentVersion.length === 40
                ? "The source update is downloaded. Update when you’re ready; building it may take a few minutes."
                : !status.installOnLaunchSupported
                  ? "The update is downloaded. Updating restarts localDot once."
                  : status.preferences.installOnLaunch
                    ? "Ready for your next launch. Update now when you’re finished, or leave it for after you quit localDot. Closing this browser tab does not quit the app."
                    : "Your download is saved. Turn on Install at next launch when you’re ready to update."
            }
          />{" "}
          Your computer and tasks keep running until you choose to stop them.
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
        title="Update localDot now?"
        description="localDot restarts to install the update, and this page reconnects by itself. It usually takes about a minute. A task that's working holds the update back. Your computer, files and sign-ins stay."
      >
        <Button variant="quiet" onClick={() => setConfirm(false)}>
          Later
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setConfirm(false);
            update.update();
          }}
        >
          Update now
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
          <UpdateSteps at={stage} failed={false} />
        </div>
      }
    >
      <Button variant="quiet" onClick={() => setHidden(true)}>
        Hide
      </Button>
    </Dialog>
  );
}

import { useId, useState } from "react";
import {
  type AppUpdateProgress,
  type ReleaseNote,
  UPDATE_STEPS,
  type UpdateStep,
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
import type { AppUpdateControl } from "./useAppUpdate.ts";

const STEP_NAMES: Record<UpdateStep, string> = {
  download: "Download",
  verify: "Check the download",
  images: "Prepare the computer",
  install: "Install",
  restart: "Restart",
};
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

// What failed, in one sentence, over the steps the update went through.
function UpdateFailure({ error, failed }: { error: string; failed: UpdateStep }) {
  const at = UPDATE_STEPS.indexOf(failed);
  return (
    <div className="settings-update-progress">
      <p className="settings-update-error">{error}</p>
      <ol className="settings-steps settings-update-steps" aria-label="Update steps">
        {UPDATE_STEPS.map((step, index) => {
          const state = index < at ? "done" : index === at ? "failed" : "todo";
          return (
            <li key={step} className="settings-step" data-state={state}>
              <StatusGlyph state={state} className="settings-step-glyph" />
              <span className="settings-step-text">
                <span className="settings-step-name">{STEP_NAMES[step]}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
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

export function AppUpdateSettings({ update }: { update: AppUpdateControl }) {
  const { status, busy } = update;
  const [confirm, setConfirm] = useState(false);
  if (!status) return update.error ? <GroupNote>{update.error}</GroupNote> : null;
  const restarting = status.phase === "installing" || update.restarting;
  const working = restarting || status.phase === "checking" || status.phase === "downloading";
  const version = status.availableVersion;
  const displayVersion = version && shown(version);
  const title = restarting
    ? "Restarting localDot…"
    : !status.supported
      ? "Update localDot manually"
      : status.phase === "checking"
        ? "Checking for updates…"
        : status.phase === "downloading"
          ? `Downloading localDot ${displayVersion}…`
          : version
            ? `localDot ${displayVersion} ${status.phase === "ready" ? "is ready" : "is available"}`
            : status.checkedAt
              ? "localDot is up to date"
              : "Check for a new version";
  const titles = [
    "Restarting localDot…",
    "Checking for updates…",
    "localDot is up to date",
    "Check for a new version",
    ...(version
      ? [
          `Downloading localDot ${displayVersion}…`,
          `localDot ${displayVersion} is ready`,
          `localDot ${displayVersion} is available`,
        ]
      : []),
  ];
  const failed = status.error && status.progress ? status.progress.step : null;
  // Once localDot stops answering, the restart is under way.
  const progress: AppUpdateProgress | null =
    update.restarting && version
      ? { step: "restart", value: null, detail: `Starting localDot ${displayVersion}` }
      : status.progress;
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
              : "This copy can’t update itself. Run localdot update in Terminal, or rebuild it if you run from source."
          }
          trailing={
            status.supported && (
              <Button
                size="sm"
                busy={busy || working}
                onClick={
                  status.phase === "ready"
                    ? () => setConfirm(true)
                    : version
                      ? update.download
                      : update.check
                }
              >
                <StableText
                  choices={["Install update", "Download update", "Check now"]}
                  value={
                    status.phase === "ready"
                      ? "Install update"
                      : version && status.phase !== "checking"
                        ? "Download update"
                        : "Check now"
                  }
                />
              </Button>
            )
          }
        >
          {failed && status.error ? (
            <UpdateFailure error={status.error} failed={failed} />
          ) : (
            progress && <UpdateProgress progress={progress} />
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
      {status.phase === "ready" && !failed && (
        <GroupNote>
          <StableText
            choices={[
              "The source update is downloaded. Install when you’re ready; building it may take a few minutes.",
              "The update is downloaded. Installing it restarts localDot once.",
              "Ready for your next launch. Install now when you’re finished, or leave it for after you quit localDot. Closing this browser tab does not quit the app.",
              "Your download is saved. Turn on Install at next launch when you’re ready to update.",
            ]}
            value={
              status.currentVersion.length === 40
                ? "The source update is downloaded. Install when you’re ready; building it may take a few minutes."
                : !status.installOnLaunchSupported
                  ? "The update is downloaded. Installing it restarts localDot once."
                  : status.preferences.installOnLaunch
                    ? "Ready for your next launch. Install now when you’re finished, or leave it for after you quit localDot. Closing this browser tab does not quit the app."
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
        title="Shut down and update?"
        description="This shuts down your computer and restarts localDot to install the update. Save any unsaved work first. Your saved files and sign-ins stay."
      >
        <Button variant="quiet" onClick={() => setConfirm(false)}>
          Later
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setConfirm(false);
            update.install();
          }}
        >
          Shut down and update
        </Button>
      </Dialog>
    </div>
  );
}

import { useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Group, GroupHead, GroupNote, GroupRow, IconTile } from "../ui/Group.tsx";
import { Switch } from "../ui/Switch.tsx";
import { StableText } from "./StableText.tsx";
import type { AppUpdateControl } from "./useAppUpdate.ts";

export function AppUpdateSettings({ update }: { update: AppUpdateControl }) {
  const { status, busy } = update;
  const [confirm, setConfirm] = useState(false);
  if (!status) return update.error ? <GroupNote>{update.error}</GroupNote> : null;
  const working =
    status.phase === "installing" || status.phase === "checking" || status.phase === "downloading";
  const version = status.availableVersion;
  const title =
    status.phase === "installing"
      ? "Installing update… Reconnecting shortly"
      : !status.supported
        ? "Development build"
        : status.phase === "checking"
          ? "Checking for updates…"
          : status.phase === "downloading"
            ? `Downloading localDot ${version?.length === 40 ? version.slice(0, 8) : version}…`
            : version
              ? `localDot ${version?.length === 40 ? version.slice(0, 8) : version} ${status.phase === "ready" ? "is ready" : "is available"}`
              : status.checkedAt
                ? "localDot is up to date"
                : "Check for a new version";
  const displayVersion = version?.length === 40 ? version.slice(0, 8) : version;
  const titles = [
    "Installing update… Reconnecting shortly",
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
  return (
    <div>
      <GroupHead title="Software update" />
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
              ? `Installed ${status.currentVersion.length === 40 ? `build ${status.currentVersion.slice(0, 8)}` : `version ${status.currentVersion}`}`
              : "Automatic updates are available in the installed app."
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
        />
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
      {(update.error || status.error) && <GroupNote>{update.error ?? status.error}</GroupNote>}
      {status.phase === "ready" && (
        <GroupNote>
          <StableText
            choices={[
              "The source update is downloaded. Install when you’re ready; building it may take a few minutes.",
              "Ready for your next launch. Install now when you’re finished, or leave it for after you quit localDot. Closing this browser tab does not quit the app.",
              "Your download is saved. Turn on Install at next launch when you’re ready to update.",
            ]}
            value={
              !status.installOnLaunchSupported
                ? "The source update is downloaded. Install when you’re ready; building it may take a few minutes."
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

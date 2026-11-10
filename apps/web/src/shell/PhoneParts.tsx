import type { ConversationEntry, Wearable } from "@localdot/protocol";
import { useRef, useState } from "react";
import { sendAfter } from "../agent/queued-draft.ts";
import { requestResearch } from "../agent/research.ts";
import type { HudActionKind } from "../cells/hud-state.ts";
import { DotAvatar } from "../dot/DotAvatar.tsx";
import { useGuest } from "../remote/guest.ts";
import type { HudAction } from "../session/status.ts";
import type { StreamPreferenceControl } from "../stage/stream-preference.ts";
import { Button } from "../ui/Button.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu.tsx";
import { triggerProps } from "../ui/Popover.tsx";
import { PauseButton } from "./HudIsland.tsx";
import type { PauseSlot, TakeSlot } from "./island.ts";
import { PANEL_NAME } from "./panel-name.ts";
import { type DisplayControl, StreamMenu } from "./StreamMenu.tsx";

const NO_RECORDINGS = "No recordings yet";

export interface SwitchView {
  label: string;
  run(): void;
}

const stopReason = (stop: HudAction) =>
  stop.busy ? "Stopping…" : stop.enabled ? undefined : "Reconnecting to the task…";

// What the computer's state asks of the user while the conversation or the list is on show, with
// its way out. Its screen says all of it.
export function ComputerNotice({
  caption,
  action,
  failed,
  onAction,
  onDetails,
}: {
  caption: string;
  action?: HudAction & { kind: HudActionKind };
  failed: boolean;
  onAction(kind: HudActionKind): void;
  onDetails(): void;
}) {
  const offered = action && action.kind !== "stop" ? action : undefined;
  return (
    <div className="phone-notice" role="status">
      <p>{caption || "Your computer isn't on."}</p>
      {offered && (
        <Button
          size="sm"
          variant="primary"
          disabledReason={offered.enabled ? undefined : "Wait a moment"}
          onClick={() => onAction(offered.kind)}
        >
          {offered.kind === "start"
            ? "Turn on"
            : offered.kind === "resume"
              ? "Resume"
              : "Try again"}
        </Button>
      )}
      {(!offered || failed) && (
        <Button size="sm" variant="quiet" onClick={onDetails}>
          Details
        </Button>
      )}
    </div>
  );
}

// The composer's own controls do these: the file chooser behind its Attach, and its field.
function typeInComposer(text: string) {
  const field = document.querySelector<HTMLTextAreaElement>(".thread-composer textarea");
  if (!field || field.readOnly) return;
  field.focus();
  field.setRangeText(text, 0, field.value.length, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

// Beside the message field: attach something, research, or the commands "/" lists.
export function PhoneAdd({ researchReason }: { researchReason?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={button}
        className="phone-plus"
        size={36}
        round
        variant="filled"
        icon="plus"
        label="Add"
        {...triggerProps("menu", open)}
        onClick={() => setOpen(true)}
      />
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={button}
        side="top"
        align="start"
        label="Add"
      >
        <MenuItem
          icon="paperclip"
          onSelect={() =>
            document
              .querySelector<HTMLElement>(".thread-composer .composer-bar > .ui-icon-button")
              ?.click()
          }
        >
          Photo or file
        </MenuItem>
        <MenuItem icon="globe" disabledReason={researchReason} onSelect={requestResearch}>
          Research a question
        </MenuItem>
        <MenuItem icon="list" onSelect={() => typeInComposer("/")}>
          Commands
        </MenuItem>
      </Menu>
    </>
  );
}

// ⋯ in a conversation, and on the computer.
export function ConversationMenuItems({
  dotHidden,
  look,
  seed,
  onShowDot,
  onWorkspace,
  hasRecordings,
  onReplay,
  model,
  entry,
  onPin,
  onRename,
  researchReason,
  sendsAfter,
  onSearch,
  switchView,
  newReason,
  onNew,
  stop,
  onStop,
  onChatSettings,
}: {
  dotHidden: boolean;
  look: readonly Wearable[];
  seed: string;
  onShowDot(): void;
  onWorkspace(): void;
  hasRecordings: boolean;
  onReplay(): void;
  // The model the next message uses, when one is chosen.
  model?: { label: string; reason?: string; open(): void };
  entry?: ConversationEntry;
  onPin(): void;
  onRename(): void;
  researchReason?: string;
  // A message can wait for the task at work to finish.
  sendsAfter: boolean;
  onSearch(): void;
  switchView: SwitchView;
  newReason?: string;
  onNew(): void;
  stop?: HudAction;
  onStop(): void;
  // A shared link's own settings, in Settings' place.
  onChatSettings?(): void;
}) {
  // A shared link's guest has what the link allows: no workspace, organizing or other views.
  const guest = useGuest();
  return (
    <>
      {dotHidden && (
        <>
          <MenuItem
            glyph={
              <span className="phone-menu-dot">
                <DotAvatar size={24} wearables={look} seed={seed} />
              </span>
            }
            onSelect={onShowDot}
          >
            Show dot
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      {!guest && (
        <MenuItem icon="list" onSelect={onWorkspace}>
          {PANEL_NAME}
        </MenuItem>
      )}
      {(!guest || guest.grant.replay) && (
        <MenuItem
          icon="history"
          disabledReason={hasRecordings ? undefined : NO_RECORDINGS}
          onSelect={onReplay}
        >
          Replay
        </MenuItem>
      )}
      {onChatSettings && (
        <MenuItem icon="settings" onSelect={onChatSettings}>
          Chat settings
        </MenuItem>
      )}
      {model && (
        <MenuItem icon="cpu" disabledReason={model.reason} onSelect={model.open}>
          {model.label}
        </MenuItem>
      )}
      {entry && !guest && (
        <MenuItem icon={entry.pinned ? "pin-off" : "pin"} onSelect={onPin}>
          {entry.pinned ? "Unpin" : "Pin to top"}
        </MenuItem>
      )}
      {entry && !guest && (
        <MenuItem icon="type" onSelect={onRename}>
          Rename
        </MenuItem>
      )}
      {!guest && (
        <MenuItem icon="globe" disabledReason={researchReason} onSelect={requestResearch}>
          Research a question
        </MenuItem>
      )}
      {sendsAfter && (
        <MenuItem icon="arrow-down" onSelect={sendAfter}>
          Send after this task
        </MenuItem>
      )}
      {!guest && (
        <MenuItem icon="search" onSelect={onSearch}>
          Search actions
        </MenuItem>
      )}
      <MenuItem icon="compose" disabledReason={newReason} onSelect={onNew}>
        New conversation
      </MenuItem>
      {!guest && (
        <MenuItem icon="layout-grid" onSelect={switchView.run}>
          {switchView.label}
        </MenuItem>
      )}
      {stop && (
        <>
          <MenuSeparator />
          <MenuItem icon="stop" disabledReason={stopReason(stop)} onSelect={onStop}>
            Stop
          </MenuItem>
        </>
      )}
    </>
  );
}

// The computer pill over the list: this computer, the others, and what the desktop keeps in its top
// bar.
export function ComputerMenuItems({
  name,
  others,
  onManage,
  onRoutines,
  hasRecordings,
  onReplay,
  onSettings,
  onKeys,
  onSearch,
  switchView,
  stoppingAll,
  onStopAll,
}: {
  name: string;
  others: readonly { id: string; name: string; open(): void }[];
  onManage(): void;
  onRoutines(): void;
  hasRecordings: boolean;
  onReplay(): void;
  onSettings(): void;
  onKeys(): void;
  onSearch(): void;
  switchView: SwitchView;
  stoppingAll: boolean;
  onStopAll(): void;
}) {
  return (
    <>
      <MenuItem icon="monitor" onSelect={onManage}>
        {name}
      </MenuItem>
      {others.map((other) => (
        <MenuItem key={other.id} icon="monitor" onSelect={other.open}>
          {`Switch to ${other.name}`}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon="repeat" onSelect={onRoutines}>
        Routines
      </MenuItem>
      <MenuItem
        icon="history"
        disabledReason={hasRecordings ? undefined : NO_RECORDINGS}
        onSelect={onReplay}
      >
        Replay
      </MenuItem>
      <MenuItem icon="settings" onSelect={onSettings}>
        Settings
      </MenuItem>
      <MenuItem icon="key-round" onSelect={onKeys}>
        Keys
      </MenuItem>
      <MenuItem icon="search" onSelect={onSearch}>
        Search actions
      </MenuItem>
      <MenuItem icon="layout-grid" onSelect={switchView.run}>
        {switchView.label}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon="stop"
        disabledReason={stoppingAll ? "Stopping…" : undefined}
        onSelect={onStopAll}
      >
        Stop everything
      </MenuItem>
    </>
  );
}

// The task's controls under the picture: Pause and Stop, and Take control across from them.
export function TaskControls({
  stop,
  pause,
  onPause,
  onContinue,
  onStop,
  take,
  onTake,
  stream,
  display,
  resume,
  onResume,
  shutDown,
  onShutDown,
}: {
  stop?: HudAction;
  pause: PauseSlot;
  onPause(): void;
  onContinue(): void;
  onStop(): void;
  take: TakeSlot;
  onTake(): void;
  stream: StreamPreferenceControl;
  display: DisplayControl;
  // A paused computer has neither a task to stop nor a picture to take: these are its way on.
  resume?: HudAction;
  onResume(): void;
  shutDown?: HudAction;
  onShutDown(): void;
}) {
  const wait = (action: HudAction) => (action.enabled ? undefined : "Wait a moment");
  return (
    <>
      {stop && (
        <>
          <PauseButton
            slot={pause}
            size={44}
            variant="filled"
            round
            onPause={onPause}
            onContinue={onContinue}
          />
          <IconButton
            variant="filled"
            round
            size={44}
            icon="stop"
            label={stop.busy ? "Stopping" : "Stop"}
            data-testid="hud-stop-session"
            disabledReason={stopReason(stop)}
            onClick={onStop}
          />
        </>
      )}
      {shutDown && (
        <IconButton
          variant="filled"
          round
          size={44}
          icon="power"
          label="Shut down"
          disabledReason={wait(shutDown)}
          onClick={onShutDown}
        />
      )}
      <StreamMenu stream={stream} display={display} />
      <span className="phone-controls-gap" />
      {resume ? (
        <Button
          variant="primary"
          size="xl"
          icon="play"
          disabledReason={wait(resume)}
          onClick={onResume}
        >
          Resume
        </Button>
      ) : (
        <Button
          variant={take.primary ? "primary" : "secondary"}
          size="xl"
          icon="hand"
          busy={take.busy}
          disabledReason={take.reason}
          onClick={onTake}
        >
          Take control
        </Button>
      )}
    </>
  );
}

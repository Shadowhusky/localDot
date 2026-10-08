import { type ReactNode, useId, useRef, useState } from "react";
import { Button } from "../Button.tsx";
import { Dialog } from "../Dialog.tsx";
import { Icon } from "../Icon.tsx";
import { IconButton } from "../IconButton.tsx";
import { Menu, MenuGroup, MenuItem, MenuSeparator } from "../Menu.tsx";
import { Popover } from "../Popover.tsx";
import { Sheet, type SheetProps } from "../Sheet.tsx";
import { Section } from "./AtomsPage.tsx";
import "./atoms.css";
import "./overlays-page.css";

const PROVIDERS = ["Anthropic", "OpenAI", "Google", "A local model"] as const;
const APPS = [
  "Browser",
  "Files",
  "Terminal",
  "Text editor",
  "Spreadsheet",
  "Image editor",
  "Calendar",
  "Mail",
  "Notes",
  "Music",
  "Maps",
  "Calculator",
];

interface Draft {
  name: string;
  provider: string;
}

const SAVED: Draft = { name: "Research assistant", provider: "Anthropic" };

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="overlays-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}

function SettingsDemo({
  side,
  modal,
  label,
}: {
  side: SheetProps["side"];
  modal?: boolean;
  label: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [saved, setSaved] = useState(SAVED);
  const [draft, setDraft] = useState(SAVED);
  const [picked, setPicked] = useState("Nothing yet");
  const dirty = draft.name !== saved.name || draft.provider !== saved.provider;
  const close = () => {
    setOpen(false);
    setDraft(saved);
  };
  return (
    <div className="overlays-demo">
      <Button ref={trigger} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <p className="overlays-status" data-testid={`saved-${side}-${modal ? "modal" : "beside"}`}>
        Saved: {saved.name} · {saved.provider}
      </p>
      <Sheet
        open={open}
        onClose={close}
        side={side}
        modal={modal}
        dirty={dirty}
        returnFocus={trigger}
        title="Models and settings"
        description="Saved settings apply to the next task."
        closeLabel="Close settings"
        footer={
          <>
            <Button variant="quiet" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabledReason={dirty ? undefined : "Nothing to save yet"}
              onClick={() => {
                setSaved(draft);
                setOpen(false);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="overlays-form">
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                className="overlays-input"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            )}
          </Field>
          <Field label="Provider">
            {(id) => (
              <span className="overlays-select">
                <select
                  id={id}
                  className="overlays-input"
                  value={draft.provider}
                  onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider}>{provider}</option>
                  ))}
                </select>
                <Icon name="chevron-down" />
              </span>
            )}
          </Field>
          <div className="overlays-inline">
            <div>
              <p className="overlays-inline-title">Main model</p>
              <p className="overlays-inline-note">{picked}</p>
            </div>
            <IconButton
              ref={more}
              label="Model actions"
              icon="more-horizontal"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu(true)}
            />
            <Menu
              open={menu}
              onClose={() => setMenu(false)}
              anchor={more}
              align="end"
              label="Model actions"
            >
              <MenuItem icon="copy" onSelect={() => setPicked("Copied the model name")}>
                Copy model name
              </MenuItem>
              <MenuItem icon="sliders-horizontal" onSelect={() => setPicked("Opened the limits")}>
                Set limits
              </MenuItem>
            </Menu>
          </div>
          <div>
            <p className="overlays-inline-title">Apps it may open</p>
            <ul className="overlays-list">
              {APPS.map((app) => (
                <li key={app}>
                  <Icon name="app-window" />
                  {app}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function DialogDemo() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [deleted, setDeleted] = useState(0);
  return (
    <div className="overlays-demo">
      <Button ref={trigger} icon="x" onClick={() => setOpen(true)}>
        Delete recording
      </Button>
      <p className="overlays-status">
        Deleted {deleted} {deleted === 1 ? "recording" : "recordings"}
      </p>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        title="Delete this recording?"
        description="The replay and its files are removed from this Mac. You can't undo this."
      >
        <Button variant="quiet" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            setDeleted((count) => count + 1);
            setOpen(false);
          }}
        >
          Delete
        </Button>
      </Dialog>
    </div>
  );
}

function PopoverDemo() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="overlays-demo">
      <Button
        ref={trigger}
        variant="quiet"
        icon="globe"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Share
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchor={trigger}
        title="Share this replay"
      >
        <p className="overlays-popover-text">
          Anyone with the link can watch it on this network. It stays here until you delete it.
        </p>
        <div className="overlays-popover-actions">
          <Button
            variant="primary"
            size="sm"
            icon={copied ? "check" : "copy"}
            onClick={() => setCopied(true)}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      </Popover>
    </div>
  );
}

function MenuDemo() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("Nothing yet");
  const [under, setUnder] = useState(0);
  return (
    <>
      <div className="atoms-row">
        <span className="atoms-label">Trigger</span>
        <IconButton
          ref={trigger}
          label="Recording actions"
          icon="more-horizontal"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        />
        <p className="overlays-status">Last choice: {choice}</p>
      </div>
      <div className="atoms-row">
        <span className="atoms-label">Under it</span>
        <Button size="sm" onClick={() => setUnder((count) => count + 1)}>
          {`Pressed ${under} ${under === 1 ? "time" : "times"}`}
        </Button>
        <p className="overlays-status">A press that closes the menu never reaches this.</p>
      </div>
      <Menu open={open} onClose={() => setOpen(false)} anchor={trigger} label="Recording actions">
        <MenuItem icon="type" onSelect={() => setChoice("Rename")}>
          Rename
        </MenuItem>
        <MenuItem icon="copy" kbd={["Mod", "D"]} onSelect={() => setChoice("Duplicate")}>
          Duplicate
        </MenuItem>
        <MenuItem icon="download" kbd={["Mod", "E"]} onSelect={() => setChoice("Export video")}>
          Export video
        </MenuItem>
        <MenuSeparator />
        <MenuGroup label="On this Mac">
          <MenuItem icon="file" onSelect={() => setChoice("Show files")}>
            Show files
          </MenuItem>
          <MenuItem
            icon="x"
            disabledReason="Stop the task first"
            onSelect={() => setChoice("Delete")}
          >
            Delete recording
          </MenuItem>
        </MenuGroup>
      </Menu>
    </>
  );
}

// A gallery page: it brings its own styles and none of the page around it.
export function OverlaysPage() {
  return (
    <div className="atoms">
      <Section
        title="Sheet"
        note="A side panel on wide screens and a bottom sheet on phones that follows your finger. While changes are unsaved, Escape, the close button, the dim area and a swipe ask before closing."
      >
        <div className="atoms-panel">
          <div className="atoms-row">
            <span className="atoms-label">Modal</span>
            <SettingsDemo side="auto" modal label="Open settings" />
          </div>
          <div className="atoms-row">
            <span className="atoms-label">Bottom</span>
            <SettingsDemo side="bottom" modal label="Open as a bottom sheet" />
          </div>
          <div className="atoms-row">
            <span className="atoms-label">Beside the page</span>
            <SettingsDemo side="inspector" modal={false} label="Open beside the page" />
          </div>
        </div>
      </Section>

      <Section
        title="Menu"
        note="Grows from its button. Arrow keys, Home, End and typing a name move through it; a press outside closes it and goes no further."
      >
        <div className="atoms-panel">
          <MenuDemo />
        </div>
      </Section>

      <Section
        title="Popover"
        note="Anchored to the control that opened it. Focus moves in and comes back when it closes."
      >
        <div className="atoms-panel">
          <div className="atoms-row">
            <span className="atoms-label">Trigger</span>
            <PopoverDemo />
          </div>
        </div>
      </Section>

      <Section
        title="Dialog"
        note="Only for a step that can't be undone. It opens beside the control that asked, and the safe choice has focus."
      >
        <div className="atoms-panel">
          <div className="atoms-row">
            <span className="atoms-label">Destructive</span>
            <DialogDemo />
          </div>
        </div>
      </Section>
    </div>
  );
}

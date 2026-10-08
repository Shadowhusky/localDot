import { useEffect, useState } from "react";
import { Badge } from "../Badge.tsx";
import { Button, type ButtonProps } from "../Button.tsx";
import { Icon } from "../Icon.tsx";
import { IconButton } from "../IconButton.tsx";
import { ICONS, type IconName } from "../icons.ts";
import { Kbd } from "../Kbd.tsx";
import { Separator } from "../Separator.tsx";
import { Spinner } from "../Spinner.tsx";
import { Tooltip } from "../Tooltip.tsx";
import "./atoms.css";
import { Section, Specimen } from "./parts.tsx";

const VARIANTS = ["primary", "secondary", "quiet"] as const;
const SIZES = ["sm", "md", "lg"] as const;
const BUSY_FOR = 1600;

function ButtonRow({ variant }: { variant: NonNullable<ButtonProps["variant"]> }) {
  const name = `${variant[0]?.toUpperCase()}${variant.slice(1)}`;
  return (
    <div className="atoms-row" data-variant={variant}>
      <span className="atoms-label">{name}</span>
      {SIZES.map((size) => (
        <Specimen key={size} caption={size}>
          <Button variant={variant} size={size}>
            {`${name} ${size}`}
          </Button>
        </Specimen>
      ))}
      <Specimen caption="Icon">
        <Button variant={variant} icon="download">
          Download
        </Button>
      </Specimen>
      <Specimen caption="Pressed" still>
        <Button variant={variant} data-pressed="squeeze">
          Pressed
        </Button>
      </Specimen>
      <Specimen caption="Unavailable">
        <Button variant={variant} disabledReason="Choose a main provider and model">
          Save
        </Button>
      </Specimen>
      <Specimen caption="Busy">
        <Button variant={variant} busy>
          Sending
        </Button>
      </Specimen>
    </div>
  );
}

function LiveButtons() {
  const [presses, setPresses] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const done = window.setTimeout(() => setBusy(false), BUSY_FOR);
    return () => window.clearTimeout(done);
  }, [busy]);
  return (
    <div className="atoms-row">
      <span className="atoms-label">Live</span>
      <Specimen caption={`Pressed ${presses} ${presses === 1 ? "time" : "times"}`}>
        <Button onClick={() => setPresses((count) => count + 1)}>Press me</Button>
      </Specimen>
      <Specimen caption="Wide: darkens, no squeeze">
        <Button variant="primary" onClick={() => setPresses((count) => count + 1)}>
          Turn on your computer while you choose a model
        </Button>
      </Specimen>
      <Specimen caption="Unavailable: focus it, hover or tap it">
        <Button
          onClick={() => setPresses((count) => count + 1)}
          disabledReason="Choose a main provider and model"
        >
          Save settings
        </Button>
      </Specimen>
      <Specimen caption="Busy while it works">
        <Button variant="primary" busy={busy} onClick={() => setBusy(true)}>
          Send
        </Button>
      </Specimen>
    </div>
  );
}

function Toolbar() {
  const [paused, setPaused] = useState(false);
  return (
    <div className="atoms-hud" role="toolbar" aria-label="Task controls">
      <Spinner size={12} />
      <span className="atoms-hud-label">{paused ? "Paused" : "Working"}</span>
      <time className="atoms-hud-time">0:42</time>
      <Separator orientation="vertical" />
      <IconButton
        label={paused ? "Continue" : "Pause after this step"}
        icon={paused ? "play" : "pause"}
        onClick={() => setPaused((value) => !value)}
      />
      <IconButton label="Stop" icon="square" kbd={["Mod", "Shift", "."]} />
    </div>
  );
}

// A gallery page: it brings its own styles and none of the page around it.
export function AtomsPage() {
  return (
    <div className="atoms">
      <Section
        title="Button"
        note="Primary, secondary and quiet at 28, 32 and 40 px. One primary per surface; pressing squeezes a small button and only darkens a wide one."
      >
        <div className="atoms-panel">
          {VARIANTS.map((variant) => (
            <ButtonRow key={variant} variant={variant} />
          ))}
          <LiveButtons />
        </div>
      </Section>

      <Section
        title="Icon button"
        note="A 16 px glyph on a 24, 28 or 32 px button with a 44 px target. Its label shows as a tooltip, with the shortcut when there is one."
      >
        <div className="atoms-panel">
          <div className="atoms-row">
            <span className="atoms-label">Sizes</span>
            {([24, 28, 32] as const).map((size) => (
              <Specimen key={size} caption={`${size}`}>
                <IconButton label={`Copy, ${size} px`} icon="copy" size={size} />
              </Specimen>
            ))}
            <Specimen caption="Pressed" still>
              <IconButton label="Pressed" icon="sliders-horizontal" data-pressed="squeeze" />
            </Specimen>
            <Specimen caption="Unavailable">
              <IconButton
                label="Replay"
                icon="play"
                disabledReason="Replays appear after your first task"
              />
            </Specimen>
            <Specimen caption="With a badge">
              <span className="atoms-badged">
                <IconButton label="Keys, one needs attention" icon="key-round" />
                <Badge kind="dot" tone="attention" label="Needs attention" />
              </span>
            </Specimen>
          </div>
          <div className="atoms-row">
            <span className="atoms-label">In a bar</span>
            <Toolbar />
          </div>
          <div className="atoms-row">
            <span className="atoms-label">Close together</span>
            {([24, 28] as const).map((size) => (
              <Specimen key={size} caption={`${size} px, 4 px apart`}>
                <div className="atoms-pair" role="toolbar" aria-label={`${size} px, 4 px apart`}>
                  <IconButton label="Pause after this step" icon="pause" size={size} />
                  <IconButton label="Stop" icon="square" size={size} />
                </div>
              </Specimen>
            ))}
            <Specimen caption="Buttons, 4 px apart">
              <div className="atoms-pair" role="toolbar" aria-label="Buttons, 4 px apart">
                <Button size="sm">Back</Button>
                <Button size="sm" variant="primary">
                  Next
                </Button>
              </div>
            </Specimen>
          </div>
        </div>
      </Section>

      <Section
        title="Tooltip"
        note="Opens after half a second, then at once while the pointer moves along a row. It repeats what the control says and is never the only place a fact appears."
      >
        <div className="atoms-row">
          <span className="atoms-label">Triggers</span>
          <Tooltip content="Copies a link to this replay">
            <Button variant="quiet" icon="copy">
              Copy link
            </Button>
          </Tooltip>
          <Tooltip content="Saves the replay as a video" kbd={["Mod", "E"]}>
            <Button variant="quiet" icon="download">
              Export
            </Button>
          </Tooltip>
          <IconButton label="More" icon="more-horizontal" />
        </div>
      </Section>

      <Section
        title="Keys"
        note="Command glyphs on Apple devices, spelled out elsewhere. Hidden on touch screens, where there is no keyboard to press."
      >
        <div className="atoms-row">
          <span className="atoms-label">Shortcuts</span>
          <Kbd keys={["Mod", "Shift", "."]} />
          <Kbd keys={["Mod", "Enter"]} />
          <Kbd keys={["Escape"]} />
          <Kbd keys={["Mod", "K"]} />
          <Kbd keys={["["]} />
        </div>
      </Section>

      <Section
        title="Badge"
        note="A dot, a count or a short label. Attention is a dot or a rim, never a fill."
      >
        <div className="atoms-panel">
          <div className="atoms-row">
            <span className="atoms-label">Dot</span>
            <Badge kind="dot" label="Ready" />
            <Badge kind="dot" tone="attention" label="Needs you" />
            <Badge kind="dot" tone="danger" label="Failed" />
          </div>
          <div className="atoms-row">
            <span className="atoms-label">Count</span>
            <Badge kind="count">{3}</Badge>
            <Badge kind="count" tone="attention" label="2 need you">
              {2}
            </Badge>
            <Badge kind="count" tone="danger" label="120 failed">
              {120}
            </Badge>
          </div>
          <div className="atoms-row">
            <span className="atoms-label">Label</span>
            <Badge>Built-in</Badge>
            <Badge tone="attention">Needs you</Badge>
            <Badge tone="danger">Failed</Badge>
          </div>
        </div>
      </Section>

      <Section
        title="Spinner and separator"
        note="The spinner turns once every 0.9 s and breathes instead under reduced motion. Separators are hairlines."
      >
        <div className="atoms-row">
          <span className="atoms-label">Spinner</span>
          <Spinner size={12} label="Loading, small" />
          <Spinner label="Loading" />
        </div>
        <Separator />
      </Section>

      <Section title="Icons" note="Lucide outlines at 16 px with a 1.5 px stroke.">
        <ul className="atoms-icons">
          {(Object.keys(ICONS) as IconName[]).map((name) => (
            <li key={name}>
              <Icon name={name} />
              <span>{name}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

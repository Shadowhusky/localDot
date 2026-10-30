import { useLayoutEffect, useRef, useState } from "react";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { SegmentedControl } from "../ui/SegmentedControl.tsx";
import { Select } from "../ui/Select.tsx";
import { SessionGlyph, type SessionStatus } from "../ui/SessionGlyph.tsx";
import { type GlyphState, StatusGlyph } from "../ui/StatusGlyph.tsx";
import { Switch } from "../ui/Switch.tsx";
import { TextField } from "../ui/TextField.tsx";

const SURFACES = ["void", "console", "raised", "raised-2", "overlay", "popover"];
const INKS = ["fg-1", "fg-2", "fg-3"];
const LIGHTS = [
  { name: "xenon · dot", token: "--color-xenon" },
  { name: "you", token: "--color-you" },
  { name: "attention", token: "--color-attention" },
];

const TYPE = [
  { token: "title-1", spec: "Title 1 · 22/28 600 −0.019em", sample: "Your computer is off" },
  { token: "title-2", spec: "Title 2 · 17/22 600 −0.025em", sample: "Send this email?" },
  { token: "title-3", spec: "Title 3 · 15/20 600 −0.015em", sample: "Before your first task" },
  {
    token: "narration",
    spec: "Narration · 16/22 500 −0.019em",
    sample: "Checking February's net total.",
  },
  {
    token: "reading",
    spec: "Reading · 14/21 400 −0.011em",
    sample: "I'll open the spreadsheet and check each month.",
  },
  { token: "body", spec: "Body · 13/18 400 −0.006em", sample: "Opened monthly-report.ods" },
  { token: "callout", spec: "Callout · 12/16 500 0", sample: "Working · step 6 · 0:42" },
  { token: "footnote", spec: "Footnote · 11/14 500 +0.0055em", sample: "TODAY 10:40" },
];

const GLYPHS: { state: GlyphState; name: string }[] = [
  { state: "done", name: "done" },
  { state: "doing", name: "doing" },
  { state: "todo", name: "todo" },
  { state: "failed", name: "fail" },
  { state: "skipped", name: "skip" },
  { state: "ask", name: "ask" },
];

const SESSION_STATUSES: SessionStatus[] = [
  "working",
  "waiting",
  "needs-you",
  "idle",
  "paused",
  "done",
  "stopped",
  "failed",
];

const MODELS = [
  { value: "sonnet", label: "Claude Sonnet 5.5" },
  { value: "opus", label: "Claude Opus 5.5" },
];

// The value a token holds, read from the page, so the label can never disagree with the swatch.
function TokenValue({ token }: { token: string }) {
  const [value, setValue] = useState("");
  useLayoutEffect(() => {
    setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim());
  }, [token]);
  return <span className="system-swatch-value">{value}</span>;
}

function Swatch({ name, token }: { name: string; token: string }) {
  return (
    <div className="system-swatch">
      <div className="system-swatch-chip" style={{ background: `var(${token})` }} />
      <span className="system-swatch-name">{name}</span>
      <TokenValue token={token} />
    </div>
  );
}

function Ramp({
  appearance,
  title,
}: {
  appearance: "graphite" | "midnight" | "daylight";
  title: string;
}) {
  return (
    <section className="system-ramp" data-appearance={appearance} aria-label={title}>
      <h3>{title}</h3>
      <div className="system-swatches">
        {SURFACES.map((name) => (
          <Swatch key={name} name={name} token={`--${appearance}-${name}`} />
        ))}
      </div>
      <div className="system-swatches">
        {INKS.map((name) => (
          <Swatch key={name} name={name} token={`--${appearance}-${name}`} />
        ))}
        {LIGHTS.map(({ name, token }) => (
          <Swatch key={name} name={name} token={token} />
        ))}
      </div>
    </section>
  );
}

function Controls() {
  const pressed = useRef<HTMLButtonElement>(null);
  const [pane, setPane] = useState("chat");
  const [mode, setMode] = useState("watch");
  const [filter, setFilter] = useState("all");
  const [model, setModel] = useState("sonnet");
  useLayoutEffect(() => {
    if (pressed.current) pressed.current.dataset.pressed = "squeeze";
  }, []);
  return (
    <div className="system-controls">
      <div className="system-row">
        <Button variant="primary" size="lg" icon="power">
          Turn on
        </Button>
        <Button variant="primary">Send</Button>
        <Button ref={pressed} variant="primary">
          Pressed
        </Button>
        <Button>Don't send</Button>
        <Button variant="quiet">Quiet</Button>
        <Button variant="destructive">Delete recording</Button>
        <Button disabledReason="Choose a model first">Unavailable</Button>
        <Button size="sm" icon="continue">
          Continue
        </Button>
      </div>
      <div className="system-row">
        <IconButton label="Settings" icon="sliders-horizontal" size={32} />
        <IconButton label="Keys" icon="key-round" size={32} attention />
        <IconButton label="Keyboard" icon="keyboard" variant="filled" round size={44} />
        <IconButton label="Send" icon="arrow-up" variant="primary" size={32} />
        <IconButton
          label="Send"
          icon="arrow-up"
          variant="primary"
          size={32}
          disabledReason="Type a message first"
        />
        <SegmentedControl
          aria-label="Pane"
          size={32}
          value={pane}
          onValueChange={setPane}
          items={[
            { value: "chat", label: "Chat" },
            { value: "activity", label: "Activity" },
          ]}
        />
        <SegmentedControl
          aria-label="Mode"
          value={mode}
          onValueChange={setMode}
          items={[
            { value: "watch", label: "Watch" },
            { value: "replay", label: "Replay" },
          ]}
        />
        <SegmentedControl
          aria-label="Steps"
          size={24}
          value={filter}
          onValueChange={setFilter}
          items={[
            { value: "all", label: "All" },
            { value: "screen", label: "Screen" },
            { value: "tools", label: "Tools" },
          ]}
        />
        <Switch label="Show dot" defaultChecked />
        <Switch label="Notify me" />
        <Chip icon="file">summary.md</Chip>
        <Chip variant="outline">Tidy my Downloads</Chip>
        <Badge>Replay</Badge>
      </div>
      <div className="system-row">
        <div className="system-field">
          <TextField aria-label="Label" placeholder="Label (optional)" />
        </div>
        <div className="system-field">
          <TextField aria-label="Key name" defaultValue="anthropic-main" autoFocus />
        </div>
        <div className="system-field">
          <Select aria-label="Model" value={model} onValueChange={setModel} items={MODELS} />
        </div>
      </div>
    </div>
  );
}

// Frame S0 of the master design, drawn with the kit itself.
export function SystemPage() {
  return (
    <div className="system">
      <p className="system-lede">
        Graphite, Midnight and Daylight ramps, type, controls and status glyphs, from the kit's own
        tokens.
      </p>
      <div className="system-ramps">
        <Ramp appearance="graphite" title="Graphite (default)" />
        <Ramp appearance="midnight" title="Midnight" />
        <Ramp appearance="daylight" title="Daylight" />
      </div>
      <section className="system-type" aria-label="Type">
        <h2>Type (system font)</h2>
        {TYPE.map(({ token, spec, sample }) => (
          <div key={token} className="system-type-row">
            <span className="system-type-spec">{spec}</span>
            <span data-token={token}>{sample}</span>
          </div>
        ))}
      </section>
      <section aria-label="Controls">
        <h2>Controls</h2>
        <Controls />
      </section>
      <section aria-label="Status glyphs">
        <h2>Status glyphs</h2>
        <div className="system-glyphs">
          {GLYPHS.map(({ state, name }) => (
            <span key={state} className="system-glyph">
              <StatusGlyph state={state} />
              {name}
            </span>
          ))}
        </div>
      </section>
      <section aria-label="Conversation status">
        <h2>Conversation status</h2>
        <div className="system-glyphs">
          {SESSION_STATUSES.map((status) => (
            <span key={status} className="system-glyph">
              <SessionGlyph status={status} />
              <SessionGlyph status={status} size={22} />
              {status}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

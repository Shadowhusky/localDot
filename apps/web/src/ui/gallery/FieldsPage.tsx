import { useEffect, useId, useState } from "react";
import { Button } from "../Button.tsx";
import { Checkbox } from "../Checkbox.tsx";
import { Combobox } from "../Combobox.tsx";
import { Field } from "../Field.tsx";
import { Icon } from "../Icon.tsx";
import type { PickerGroup, PickerItem } from "../listbox.ts";
import { MoneyField } from "../MoneyField.tsx";
import { RadioCards } from "../RadioCards.tsx";
import { SegmentedControl } from "../SegmentedControl.tsx";
import { Select } from "../Select.tsx";
import { Switch } from "../Switch.tsx";
import { TabPanel, Tabs } from "../Tabs.tsx";
import { TextArea } from "../TextArea.tsx";
import { TextField } from "../TextField.tsx";
import "./atoms.css";
import "./fields.css";
import { Section, Specimen } from "./parts.tsx";

const AUTONOMY: PickerItem[] = [
  { value: "ask", label: "Ask before each step" },
  {
    value: "risky",
    label: "Ask before risky steps",
    description: "Sending, uploading, installing and paying",
  },
  { value: "never", label: "Never ask", disabledReason: "Needs a task budget first" },
  { value: "watch", label: "Watch only" },
];

const PROVIDERS: PickerGroup[] = [
  {
    label: "Hosted",
    items: [
      { value: "anthropic", label: "Anthropic" },
      { value: "deepseek", label: "DeepSeek" },
      { value: "google", label: "Google" },
      { value: "mistral", label: "Mistral" },
      { value: "openrouter", label: "OpenRouter", keywords: "router many" },
      { value: "azure", label: "Azure", disabledReason: "Available in a later release" },
    ],
  },
  {
    label: "On this Mac",
    items: [
      { value: "lmstudio", label: "LM Studio", keywords: "local" },
      { value: "ollama", label: "Ollama", keywords: "local" },
    ],
  },
];

const MODELS: PickerItem[] = [
  { value: "claude-opus-4-1", label: "Claude Opus 4.1", keywords: "claude-opus-4-1" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", keywords: "claude-sonnet-4-5" },
  { value: "claude-sonnet-4", label: "Claude Sonnet 4", keywords: "claude-sonnet-4" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5", keywords: "claude-haiku-4-5" },
  {
    value: "claude-3-haiku",
    label: "Claude Haiku 3",
    keywords: "claude-3-haiku",
    disabledReason: "Cannot see the screen",
  },
  { value: "deepseek-chat", label: "DeepSeek Chat", keywords: "deepseek-chat v3" },
  { value: "gemini-2-5-pro", label: "Gemini 2.5 Pro", keywords: "gemini-2.5-pro google" },
  { value: "gemini-2-5-flash", label: "Gemini 2.5 Flash", keywords: "gemini-2.5-flash" },
  { value: "mistral-large", label: "Mistral Large", keywords: "mistral-large-latest" },
  { value: "qwen3-coder", label: "Qwen3 Coder", keywords: "qwen3-coder-480b" },
  { value: "glm-4-6", label: "GLM 4.6", keywords: "glm-4.6 zai" },
  { value: "kimi-k2", label: "Kimi K2", keywords: "kimi-k2-instruct moonshot" },
];

const SPEEDS = [
  { value: "0.5", label: "0.5×" },
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "4", label: "4×" },
];

function Swatch({ appearance }: { appearance: "graphite" | "midnight" }) {
  return <span className="fields-swatch" data-appearance={appearance} />;
}

function TextFields() {
  const [name, setName] = useState("Quarterly report");
  const [id, setId] = useState("claude sonnet!");
  const [budget, setBudget] = useState("3.00");
  const problem = /^[\w.:/-]+$/.test(id) ? undefined : "Use letters, digits, dots and dashes";
  return (
    <div className="fields-grid">
      <Field label="Task name" description="Shown in your replays">
        <TextField value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Search keys">
        <TextField placeholder="Name or provider" prefix={<Icon name="search" />} />
      </Field>
      <Field label="Custom model ID" description="As your provider spells it" error={problem}>
        <TextField
          value={id}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setId(event.target.value)}
        />
      </Field>
      <Field label="Task budget" description="dot stops and asks when a task reaches it">
        <MoneyField value={budget} onValueChange={setBudget} />
      </Field>
      <Field label="Main model" disabledReason="Choose a provider first">
        <TextField value="" placeholder="Model ID" onChange={() => {}} />
      </Field>
      <Field label="In a sheet" description="36 px tall where there is room to breathe">
        <TextField size="lg" placeholder="Name this key" />
      </Field>
    </div>
  );
}

function Message() {
  const [text, setText] = useState("");
  return (
    <div className="fields-message">
      <p className="fields-marker" data-testid="above-message">
        Above the message: this line never moves while the field grows.
      </p>
      <Field label="Message" description="Grows from one line to eight, then scrolls">
        <TextArea
          placeholder="Ask dot to do something"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
    </div>
  );
}

function Choices() {
  const [narration, setNarration] = useState(true);
  const [sounds, setSounds] = useState(false);
  const [files, setFiles] = useState(false);
  const [dot, setDot] = useState(true);
  const [notify, setNotify] = useState(false);
  return (
    <div className="fields-columns">
      <div className="atoms-panel fields-list">
        <Checkbox
          label="Show narration"
          description="dot says what it is doing as it works"
          checked={narration}
          onCheckedChange={setNarration}
        />
        <Checkbox label="Play sounds" checked={sounds} onCheckedChange={setSounds} />
        <Checkbox
          label="Include every file"
          indeterminate={!files}
          checked={files}
          onCheckedChange={setFiles}
        />
        <Checkbox
          label="Keep downloads"
          disabledReason="Downloads are kept while the computer is on"
        />
      </div>
      <div className="atoms-panel fields-list">
        <Switch
          label="Show dot"
          description="dot's face on the curtain and beside the stage"
          checked={dot}
          onCheckedChange={setDot}
        />
        <Switch
          label="Notify me when a task needs me"
          checked={notify}
          onCheckedChange={setNotify}
        />
        <Switch label="Start at login" disabledReason="Install localDot to start it at login" />
      </div>
    </div>
  );
}

function Themes() {
  const [theme, setTheme] = useState("graphite");
  const [autonomy, setAutonomy] = useState("risky");
  return (
    <div className="fields-columns">
      <Field label="Theme" description="Applies to this browser">
        <RadioCards
          layout="tiles"
          value={theme}
          onValueChange={setTheme}
          options={[
            { value: "graphite", label: "Graphite", preview: <Swatch appearance="graphite" /> },
            { value: "midnight", label: "Midnight", preview: <Swatch appearance="midnight" /> },
          ]}
        />
      </Field>
      <Field label="When dot asks first">
        <RadioCards
          value={autonomy}
          onValueChange={setAutonomy}
          options={AUTONOMY.map(({ value, label, description, disabledReason }) => ({
            value,
            label,
            description,
            disabledReason,
          }))}
        />
      </Field>
    </div>
  );
}

// Clicks through A, B and C in quick succession so a screen recording can show the thumb redirecting.
function Segments() {
  const [speed, setSpeed] = useState("1");
  const [view, setView] = useState("watch");
  const [tab, setTab] = useState("chat");
  const tabs = useId();
  return (
    <div className="atoms-panel">
      <div className="atoms-row">
        <span className="atoms-label">Segmented</span>
        <Specimen caption="28, replay speed">
          <SegmentedControl
            aria-label="Replay speed"
            items={SPEEDS}
            value={speed}
            onValueChange={setSpeed}
          />
        </Specimen>
        <Specimen caption="24, with an unavailable segment">
          <SegmentedControl
            aria-label="View"
            size={24}
            items={[
              { value: "watch", label: "Watch" },
              { value: "replay", label: "Replay" },
              { value: "compare", label: "Compare", disabledReason: "Compare needs two replays" },
            ]}
            value={view}
            onValueChange={setView}
          />
        </Specimen>
      </div>
      <div className="atoms-row">
        <span className="atoms-label">Tabs</span>
        <Specimen caption="Chat and Activity, each with its panel">
          <div className="fields-tabs">
            <Tabs
              id={tabs}
              aria-label="Rail"
              items={[
                { value: "chat", label: "Chat" },
                { value: "activity", label: "Activity" },
              ]}
              value={tab}
              onValueChange={setTab}
            />
            <TabPanel tabsId={tabs} value="chat" selected={tab} className="fields-panel">
              What would you like done?
            </TabPanel>
            <TabPanel tabsId={tabs} value="activity" selected={tab} className="fields-panel">
              No steps yet. They appear here as dot works.
            </TabPanel>
          </div>
        </Specimen>
      </div>
    </div>
  );
}

function Pickers() {
  const [autonomy, setAutonomy] = useState("risky");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("claude-sonnet-4-5");
  const [taps, setTaps] = useState(0);
  return (
    <div className="fields-grid">
      <Field label="Autonomy" description="How often dot checks with you">
        <Select value={autonomy} onValueChange={setAutonomy} items={AUTONOMY} />
      </Field>
      <Field label="Main provider">
        <Combobox
          value={provider}
          onValueChange={setProvider}
          groups={PROVIDERS}
          placeholder="Choose a provider"
          searchPlaceholder="Search providers"
        />
      </Field>
      <Field label="Main model" description="Plans the task and works the computer">
        <Combobox
          value={model}
          onValueChange={setModel}
          items={MODELS}
          placeholder="Choose a model"
          searchPlaceholder="Search models"
          customDescription="Use as a custom model ID"
        />
      </Field>
      <Field label="Fast model" disabledReason="Choose a main provider first">
        <Select value="" onValueChange={() => {}} items={AUTONOMY} placeholder="Choose a model" />
      </Field>
      <div className="ui-field">
        <span className="ui-field-label">Under the lists</span>
        <Button className="fields-under" onClick={() => setTaps((count) => count + 1)}>
          {`Taps that reached the page: ${taps}`}
        </Button>
      </div>
    </div>
  );
}

// Stands in for a settings sheet that closes on Escape or a click on its backdrop: neither may reach it
// while a list inside is open.
function Panel() {
  const [open, setOpen] = useState(true);
  const [closed, setClosed] = useState(0);
  const [autonomy, setAutonomy] = useState("ask");
  const close = () => {
    setOpen(false);
    setClosed((count) => count + 1);
  };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setOpen(false);
      setClosed((count) => count + 1);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [open]);
  return (
    <div className="fields-stage">
      <div
        className="fields-backdrop"
        data-testid="panel-backdrop"
        aria-hidden="true"
        onClick={(event) => {
          if (open && event.target === event.currentTarget) close();
        }}
      />
      <section className="atoms-panel fields-sheet" aria-label="Settings panel">
        <p className="fields-sheet-state" data-testid="panel-state">
          {open ? "Panel open" : "Panel closed"} · closed {closed} {closed === 1 ? "time" : "times"}
        </p>
        {open ? (
          <Field label="Autonomy in the panel">
            <Select value={autonomy} onValueChange={setAutonomy} items={AUTONOMY} />
          </Field>
        ) : (
          <Button size="sm" onClick={() => setOpen(true)}>
            Open the panel
          </Button>
        )}
      </section>
    </div>
  );
}

// A gallery page: it brings its own styles and none of the page around it.
export function FieldsPage() {
  return (
    <div className="atoms">
      <Section
        title="Text fields"
        note="A label above, a hint or an error below in the same place, so nothing under the field moves when one replaces the other. 32 px, 36 in sheets, 44 on a touch screen."
      >
        <div className="atoms-panel">
          <TextFields />
        </div>
      </Section>

      <Section
        title="Text area"
        note="It grows with its text from one line to eight. What sits above it stays put."
      >
        <div className="atoms-panel">
          <Message />
        </div>
      </Section>

      <Section
        title="Checkbox and switch"
        note="The whole row takes the press. A switch applies at once; its knob stretches while held. An unavailable choice stays readable and says why."
      >
        <Choices />
      </Section>

      <Section
        title="Radio cards"
        note="One choice from a few, each with room for a picture or a line of detail. The chosen card wears a ring and a check."
      >
        <div className="atoms-panel">
          <Themes />
        </div>
      </Section>

      <Section
        title="Segmented control and tabs"
        note="The thumb slides to the chosen segment and, interrupted, sets off again from where it is. Tabs look the same and show a panel."
      >
        <Segments />
      </Section>

      <Section
        title="Select and combobox"
        note="A field-shaped trigger. On a desktop the list opens beside it; on a phone it rises as a sheet. The combobox adds a search field and can take a value of your own."
      >
        <div className="atoms-panel">
          <Pickers />
        </div>
      </Section>

      <Section
        title="Inside a panel"
        note="Escape or a press outside closes only the open list. The panel around it, which closes on Escape or a click on the dimmed backdrop, stays open with its choices."
      >
        <Panel />
      </Section>
    </div>
  );
}

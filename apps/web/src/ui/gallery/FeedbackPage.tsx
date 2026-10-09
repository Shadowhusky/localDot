import { useEffect, useRef, useState } from "react";
import { StillFrame } from "../../gallery/StillFrame.tsx";
import { Announcer } from "../Announcer.tsx";
import { Banner } from "../Banner.tsx";
import { Button } from "../Button.tsx";
import { EmptyState } from "../EmptyState.tsx";
import { IconButton } from "../IconButton.tsx";
import { Meter } from "../Meter.tsx";
import { Progress } from "../Progress.tsx";
import { Separator } from "../Separator.tsx";
import { Skeleton } from "../Skeleton.tsx";
import { Spinner } from "../Spinner.tsx";
import { showToast, Toaster } from "../Toast.tsx";
import { Section, Specimen } from "./parts.tsx";
import "./atoms.css";
import "./feedback-page.css";

const DOWNLOAD_MS = 2400;
const RELOAD_MS = 1500;

const FILES = [
  { name: "monthly-report.ods", detail: "Spreadsheet · 18 KB" },
  { name: "summary.txt", detail: "Text · 2 KB" },
  { name: "chart.png", detail: "Image · 240 KB" },
];

function stopFailed() {
  showToast({
    id: "stop",
    title: "Couldn't confirm the stop",
    description: "Your computer may still be working.",
    tone: "danger",
    action: { label: "Check again", onAction: stopped },
  });
}

function stopped() {
  showToast({ id: "stop", title: "Stopped", tone: "success" });
}

function ToastStage() {
  const hud = useRef<HTMLDivElement>(null);
  const [undone, setUndone] = useState(0);
  const saved = () =>
    showToast({ title: "Saved to Downloads", description: "summary.txt · 2 KB", tone: "success" });
  const moved = () =>
    showToast({
      title: "Key moved to Keys",
      action: { label: "Undo", onAction: () => setUndone((count) => count + 1) },
    });
  return (
    <div className="feedback-toasts">
      <div className="feedback-stage">
        <div className="feedback-screen">
          <StillFrame />
        </div>
        <div ref={hud} className="atoms-hud feedback-hud" role="toolbar" aria-label="Task controls">
          <Spinner size={12} />
          <span className="atoms-hud-label">Saving summary.txt</span>
          <time className="atoms-hud-time">0:08</time>
          <Separator orientation="vertical" />
          <IconButton label="Stop" icon="stop" onClick={stopFailed} />
        </div>
        <Toaster anchor={hud} />
      </div>
      <div className="feedback-controls">
        <Button onClick={saved}>Show a result</Button>
        <Button onClick={stopFailed}>Show a failure</Button>
        <Button onClick={moved}>Show one with Undo</Button>
        <Button
          onClick={() => {
            stopFailed();
            moved();
            saved();
          }}
        >
          Show three
        </Button>
        <p className="feedback-note" data-testid="undone">
          Undo pressed {undone} {undone === 1 ? "time" : "times"}
        </p>
      </div>
    </div>
  );
}

function LiveBanner() {
  const [open, setOpen] = useState(false);
  return (
    <div className="feedback-flow">
      <Button onClick={() => setOpen((value) => !value)}>
        {open ? "Hide the message" : "Show a message"}
      </Button>
      <Banner
        open={open}
        announce
        tone="danger"
        title="Couldn't save your settings"
        onDismiss={() => setOpen(false)}
        actions={
          <Button size="sm" onClick={() => setOpen(false)}>
            Try again
          </Button>
        }
      >
        Your changes are kept. Check the connection and try again.
      </Banner>
      <p className="feedback-note" data-testid="below-banner">
        What follows slides down to make room, and back up when the message closes.
      </p>
    </div>
  );
}

function Banners() {
  return (
    <div className="feedback-stack">
      <Banner
        title="Your computer restarts tonight at 2:00"
        actions={<Button size="sm">Restart now</Button>}
      >
        Updates install while it's idle. Nothing you leave open is lost.
      </Banner>
      <Banner
        tone="attention"
        icon="lock"
        title="A key was in your message"
        actions={
          <>
            <Button size="sm" variant="primary">
              Move to Keys
            </Button>
            <Button size="sm">Discard</Button>
          </>
        }
      >
        It was taken out before sending.
      </Banner>
      <Banner tone="danger" title="Downloads couldn't be refreshed" onDismiss={() => {}}>
        Your computer is still starting. They'll appear once it's ready.
      </Banner>
      <LiveBanner />
    </div>
  );
}

function LiveDownload() {
  const [started, setStarted] = useState<number>();
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (started === undefined) return;
    let frame = requestAnimationFrame(function tick(time) {
      setNow(time);
      if (time - started < DOWNLOAD_MS) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [started]);
  const value = started === undefined ? 0 : Math.min(1, (now - started) / DOWNLOAD_MS);
  const running = started !== undefined && value < 1;
  return (
    <div className="feedback-download">
      <Progress
        variant="ring"
        size={20}
        label="Downloading chart.png"
        value={value}
        valueText={`${Math.round(value * 100)}%`}
      />
      <div className="feedback-download-text">
        <span>chart.png</span>
        <Progress label="Downloading chart.png" value={value} />
      </div>
      <Button
        size="sm"
        busy={running}
        onClick={() => {
          setStarted(performance.now());
          setNow(performance.now());
        }}
      >
        Download
      </Button>
    </div>
  );
}

function Progresses() {
  return (
    <div className="atoms-panel">
      <div className="atoms-row">
        <span className="atoms-label">Bar</span>
        <div className="feedback-bars">
          {[0, 0.4, 1].map((value) => (
            <figure key={value} className="feedback-figure">
              <Progress label={`Export ${value * 100}%`} value={value} />
              <figcaption>{`${value * 100}%`}</figcaption>
            </figure>
          ))}
          <figure className="feedback-figure">
            <Progress label="Preparing the export" />
            <figcaption>Length unknown</figcaption>
          </figure>
        </div>
      </div>
      <div className="atoms-row">
        <span className="atoms-label">Ring</span>
        {([16, 20, 24] as const).map((size) => (
          <Specimen key={size} caption={`${size} px`}>
            <Progress variant="ring" size={size} label="Downloading" value={0.4} />
          </Specimen>
        ))}
        <Specimen caption="Length unknown">
          <Progress variant="ring" size={20} label="Downloading" />
        </Specimen>
        <Specimen caption="Done">
          <Progress variant="ring" size={20} label="Downloaded" value={1} />
        </Specimen>
      </div>
      <div className="atoms-row">
        <span className="atoms-label">Live</span>
        <LiveDownload />
      </div>
    </div>
  );
}

function Meters() {
  const [used, setUsed] = useState(62);
  return (
    <div className="atoms-panel">
      <div className="feedback-meters">
        <Meter label="Primary window" value={used} valueText={`${used}% used`} />
        <Meter label="Secondary window" value={92} valueText="92% used" />
      </div>
      <div className="atoms-row">
        <Button size="sm" onClick={() => setUsed((value) => (value >= 98 ? 12 : value + 9))}>
          Use more
        </Button>
      </div>
    </div>
  );
}

function FileRows({ loading }: { loading: boolean }) {
  return (
    <ul className="feedback-files" aria-busy={loading || undefined}>
      {FILES.map((file) => (
        <li key={file.name}>
          <Skeleton loading={loading} shape="block" width="32px" height="32px">
            <span className="feedback-file-tile" aria-hidden="true" />
          </Skeleton>
          <span className="feedback-file-text">
            <Skeleton loading={loading} width="18ch">
              <span className="feedback-file-name">{file.name}</span>
            </Skeleton>
            <Skeleton loading={loading} width="12ch">
              <span className="feedback-file-detail">{file.detail}</span>
            </Skeleton>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Skeletons() {
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!loading) return;
    const done = window.setTimeout(() => setLoading(false), RELOAD_MS);
    return () => window.clearTimeout(done);
  }, [loading]);
  return (
    <div className="feedback-columns">
      <figure className="feedback-figure">
        <div className="atoms-panel">
          <FileRows loading />
        </div>
        <figcaption>Loading</figcaption>
      </figure>
      <figure className="feedback-figure">
        <div className="atoms-panel">
          <FileRows loading={loading} />
          <div className="atoms-row">
            <Button size="sm" onClick={() => setLoading(true)} busy={loading}>
              Reload
            </Button>
          </div>
        </div>
        <figcaption>Loaded: reload to watch the rows fill in without moving</figcaption>
      </figure>
      <figure className="feedback-figure">
        <div className="atoms-panel">
          <p className="feedback-paragraph">
            <Skeleton loading lines={3} />
          </p>
        </div>
        <figcaption>A paragraph</figcaption>
      </figure>
    </div>
  );
}

function Empties() {
  return (
    <div className="feedback-columns">
      <figure className="feedback-figure">
        <div className="atoms-panel feedback-empty-panel">
          <EmptyState
            icon="play"
            title="No recordings yet"
            actions={<Button size="sm">Start a task</Button>}
          >
            Each task you run is recorded here, so you can watch it again.
          </EmptyState>
        </div>
        <figcaption>Centred</figcaption>
      </figure>
      <figure className="feedback-figure">
        <div className="atoms-panel">
          <EmptyState layout="start" title="What would you like done?" />
        </div>
        <figcaption>Where a list starts</figcaption>
      </figure>
    </div>
  );
}

export function FeedbackPage() {
  return (
    <div className="atoms">
      <Announcer />
      <Section
        title="Toasts"
        note="Results hang under the HUD, newest in front, and never move the page. Hover or focus the stack to lay it out; swipe one sideways or up to send it away. Each stays four seconds once in front, a failure until it is dismissed."
      >
        <ToastStage />
      </Section>
      <Section
        title="Banners"
        note="A message that belongs to one panel, in its flow. It stays in place and opens by sliding what follows down."
      >
        <Banners />
      </Section>
      <Section
        title="Progress"
        note="A 4 px bar or a ring. Without a value, a short stretch sweeps along a 2 px line in the same room. A finished ring closes and draws a check."
      >
        <Progresses />
      </Section>
      <Section
        title="Meters"
        note="How much of a limit is used. From 90% the fill brightens and says so in words."
      >
        <Meters />
      </Section>
      <Section
        title="Skeletons"
        note="Each holds the room its content will take. The bones show only if loading lasts, and the content fades in over them."
      >
        <Skeletons />
      </Section>
      <Section
        title="Empty states"
        note="What a panel shows once it has loaded and holds nothing yet."
      >
        <Empties />
      </Section>
    </div>
  );
}

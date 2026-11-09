import {
  type Blocker,
  blockerLine,
  modelBlock,
  STALL,
  type TaskModelRef,
} from "@localdot/protocol";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { HudActionKind } from "../cells/hud-state.ts";
import { KeyForm } from "../keys/KeyForm.tsx";
import { type KeydHealth, type KeyRecord, vaultLocked } from "../keys/keys-api.ts";
import { UNLOCK_PRIVACY, UnlockKeys } from "../keys/UnlockKeys.tsx";
import type { KeysController } from "../keys/useKeys.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import type { HudAction } from "../session/status.ts";
import type { ModelNames } from "../settings/model-names.ts";
import type { ModelGroup, ModelOption } from "../settings/model-options.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useMediaQuery } from "../ui/media.ts";
import { Select } from "../ui/Select.tsx";
import type { DotWait } from "./Composer.tsx";
import type { AgentBlocker } from "./model.ts";
import { timeLabel } from "./thread.ts";
import { useAppConnect } from "./useAppConnect.ts";

const TOUCH = "(hover: none) and (pointer: coarse)";

type BlockerOf<K extends Blocker["kind"]> = Omit<AgentBlocker, "blocker"> & {
  readonly blocker: Extract<Blocker, { kind: K }>;
};

export interface FixDeps {
  api: ApiClient;
  sessionId: string;
  keys: KeysController;
  // The model card: the models to go on with, what dot is on now and how it tries again.
  models: {
    groups: readonly ModelGroup[];
    current?: string;
    // The task runs on another model than the chosen one, which trying again would keep.
    differs: boolean;
    remember(option: ModelOption): Promise<boolean>;
  };
  // What the task's own state says of its model, newer than the card's own words.
  stall?: { reason?: string; detail?: string };
  planResets?: string | null;
  local: boolean;
  retry: { run(): Promise<boolean>; reason?: string };
  computer: {
    action?: HudAction & { kind: HudActionKind };
    run(kind: HudActionKind): void;
  };
  runtimeChanged(): void;
  onOpenKeys(trigger: HTMLButtonElement, id?: string): void;
}

// What the user can do about what stops dot, right where dot said so: localDot's own card, drawn
// only from the task's blocker events and never from anything dot or a page wrote. The words are
// fixed by kind, and a secret goes straight from the card to the key service.
export function FixCards({ blockers, deps }: { blockers: readonly AgentBlocker[]; deps: FixDeps }) {
  return blockers.map((open) => <FixCard key={open.blockerId} open={open} deps={deps} />);
}
// What a message moves on from while cards are up: a card that takes a secret warns that a message
// isn't kept secret.
export function fixWait(blockers: readonly AgentBlocker[]): DotWait | undefined {
  if (!blockers.length) return undefined;
  return blockers.some(
    ({ blocker }) =>
      blocker.kind === "keys_locked" || (blocker.kind === "key" && blocker.problem !== "rebound"),
  )
    ? "private-fix"
    : "fix";
}
// Keys already open need no card, whatever a slower word from the task says.
export const fixesToShow = (blockers: readonly AgentBlocker[], health: KeydHealth | null) =>
  blockers.filter((open) => open.blocker.kind !== "keys_locked" || vaultLocked(health));

function FixCard({ open, deps }: { open: AgentBlocker; deps: FixDeps }) {
  const { blocker } = open;
  switch (blocker.kind) {
    case "keys_locked":
      return <KeysFix open={{ ...open, blocker }} deps={deps} />;
    case "key":
      return <KeyFix open={{ ...open, blocker }} deps={deps} />;
    case "app":
      return <AppFix open={{ ...open, blocker }} deps={deps} />;
    case "model":
      return <ModelFix open={{ ...open, blocker }} deps={deps} />;
    case "computer":
      return <ComputerFix open={{ ...open, blocker }} deps={deps} />;
    case "runtime":
      return <RuntimeFix open={{ ...open, blocker }} deps={deps} />;
  }
}

// The line a card leaves in the thread.
export function FixLine({ blocker, names }: { blocker: AgentBlocker; names?: ModelNames }) {
  const moved = blocker.cleared?.movedTo;
  const time = blocker.cleared?.time ?? blocker.time;
  const outcome = blocker.cleared?.outcome;
  return (
    <p className="thread-divider">
      <span>
        {blockerLine(
          blocker.blocker,
          !outcome || outcome === "moot" ? "open" : outcome,
          moved && (names?.name(moved.provider, moved.model) ?? moved.model),
        )}
        {time !== undefined && <time className="num"> · {timeLabel(time)}</time>}
      </span>
    </p>
  );
}

function Shell({
  kind,
  title,
  children,
}: {
  kind: Blocker["kind"];
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  const card = useRef<HTMLElement>(null);
  const touch = useMediaQuery(TOUCH);
  // Typing starts in its field when nothing else has the focus, so the card never takes the keys
  // from what you were typing elsewhere. A phone keeps its keyboard down until a field is tapped.
  useEffect(() => {
    const active = document.activeElement;
    if (touch || (active && active !== document.body)) return;
    card.current?.querySelector<HTMLElement>("input, textarea")?.focus({ preventScroll: true });
  }, [touch]);
  return (
    <section ref={card} className="thread-recovery thread-fix" aria-labelledby={id} data-fix={kind}>
      <p className="thread-fix-origin">
        <Icon name="lock" size={12} />
        <span>localDot</span>
      </p>
      <h3 id={id} className="thread-recovery-title">
        {title}
      </h3>
      {children}
    </section>
  );
}

// The user's way out, when dot can go on without it: dot hears, and says what is left.
function NotNow({ open, deps }: { open: AgentBlocker; deps: FixDeps }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (open.required) return null;
  return (
    <>
      {failed && (
        <p className="thread-recovery-reason" role="alert">
          That didn't go through. Try again.
        </p>
      )}
      <Button
        variant="quiet"
        busy={busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          void dismissBlocker(deps.api, deps.sessionId, open.blockerId)
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      >
        Not now
      </Button>
    </>
  );
}

export const dismissBlocker = (api: ApiClient, sessionId: string, blockerId: string) =>
  api.post(`/api/agent/sessions/${sessionId}/blockers/${blockerId}/dismiss`);

function KeysFix({ open, deps }: { open: BlockerOf<"keys_locked">; deps: FixDeps }) {
  const setup = deps.keys.health?.vault?.state === "setup";
  const { unlock } = deps.keys;
  const title = setup ? "Choose a passphrase for your saved keys" : "Unlock your saved keys";
  return (
    <Shell kind="keys_locked" title={title}>
      <p className="thread-recovery-text">
        {setup
          ? "dot needs your saved keys and passwords, and they need a passphrase first. You'll enter it after each restart of the computer running localDot."
          : "dot needs your saved keys and passwords, which lock each time the computer running localDot restarts. Unlock them and dot carries on by itself."}
      </p>
      {unlock && (
        <UnlockKeys
          setup={setup}
          unlock={unlock}
          label={setup ? "Choose a passphrase" : "Unlock saved keys"}
          actions={<NotNow open={open} deps={deps} />}
        />
      )}
      <p className="thread-recovery-reason">{UNLOCK_PRIVACY}</p>
    </Shell>
  );
}

const keyName = (record: KeyRecord | undefined, id: string) => record?.metadata?.label || id;
const noSaving = (health: KeydHealth | null) =>
  health && !health.online ? "Key protection is off, so the key can't be saved." : undefined;

function KeyFix({ open, deps }: { open: BlockerOf<"key">; deps: FixDeps }) {
  const { id, problem } = open.blocker;
  const record = deps.keys.keys.find((key) => key.id === id);
  const name = keyName(record, id);
  // Its destination was changed behind localDot's back, so nothing here can be trusted to re-save
  // it: the key is removed and added again by hand, in Keys.
  if (problem === "rebound" || record?.rebound)
    return (
      <Shell kind="key" title={`Your ${name} key was changed outside localDot`}>
        <p className="thread-recovery-text">
          Where this key is sent was changed outside localDot, so dot won't use it. Remove it and
          add it again; dot carries on by itself.
        </p>
        <div className="thread-recovery-actions">
          <Button
            variant="primary"
            icon="key-round"
            onClick={(event) => deps.onOpenKeys(event.currentTarget)}
          >
            Open Keys
          </Button>
          <NotNow open={open} deps={deps} />
        </div>
      </Shell>
    );
  // Where the model itself met the refusal, the key may be fine: trying again is the other way on.
  const way = open.required ? (
    <Button variant="quiet" onClick={() => void deps.retry.run()}>
      Try again
    </Button>
  ) : (
    <NotNow open={open} deps={deps} />
  );
  return (
    <Shell
      kind="key"
      title={problem === "rejected" ? `Your ${name} key was refused` : `Re-enter your ${name} key`}
    >
      <p className="thread-recovery-text">
        {problem === "rejected"
          ? "The service didn't accept this key. Enter a new one and dot carries on by itself."
          : "dot can't use this key as it's stored. Enter it again and dot carries on by itself."}
      </p>
      {record ? (
        <KeyForm
          active
          reenter={record}
          save={deps.keys.save}
          busy={deps.keys.busy}
          unavailable={noSaving(deps.keys.health)}
          actions={way}
        />
      ) : (
        <>
          <p className="thread-recovery-reason">Looking up the key…</p>
          <div className="thread-recovery-actions">{way}</div>
        </>
      )}
    </Shell>
  );
}

function AppFix({ open, deps }: { open: BlockerOf<"app">; deps: FixDeps }) {
  const { connector, name, host } = open.blocker;
  // The daemon hears the sign-in finish by itself and clears the card on every device.
  const sign = useAppConnect({ api: deps.api, connector, onConnected: () => {} });
  return (
    <Shell kind="app" title={`Connect ${name}`}>
      <p className="thread-recovery-text">
        {sign.waiting
          ? sign.waiting.remote
            ? "The sign-in opened in the browser on your Mac, where your accounts are. It can't be finished from this device."
            : `Approve ${name} in your browser. dot carries on when you're done.`
          : `dot needs ${name}, and its sign-in has ended. You approve it in your browser, and dot carries on by itself.`}
      </p>
      <p className="thread-recovery-reason">{host}</p>
      {sign.waiting?.page && (
        <p className="thread-recovery-reason">
          <a href={sign.waiting.page} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
        </p>
      )}
      {sign.problem && (
        <p className="thread-recovery-reason" role="alert">
          {sign.problem}
        </p>
      )}
      <div className="thread-recovery-actions">
        <Button variant="primary" busy={sign.starting} onClick={() => void sign.connect()}>
          {sign.waiting ? "Open again" : "Connect"}
        </Button>
        <NotNow open={open} deps={deps} />
      </div>
    </Shell>
  );
}

const ANOTHER = "or carry on with another model";
const PLAN_LIMIT = (plan: string) => ({
  title: "Paused at your plan's limit",
  text: `Your ${plan} plan is at its limit. Wait for it to reset, ${ANOTHER}.`,
});
const MODEL_WORDS: Record<string, { title: string; text: string }> = {
  [STALL.modelRefused]: {
    title: "The provider could not process my request",
    text: `The provider turned this request down. Try again, ${ANOTHER}.`,
  },
  [STALL.modelUnavailable]: {
    title: "The model isn't answering",
    text: `I tried several times. Try again, ${ANOTHER}.`,
  },
  [STALL.providerLimit]: {
    title: "Your provider's credit or usage limit is reached",
    text: `Add credit or wait for your plan to reset, then try again, ${ANOTHER}.`,
  },
  "chatgpt plan limit reached": PLAN_LIMIT("ChatGPT"),
  "claude code plan limit reached": PLAN_LIMIT("Claude"),
};

const refOf = ({ choice }: ModelOption): TaskModelRef => ({
  provider: choice.provider,
  model: choice.model,
  ...(choice.key ? { key: choice.key } : {}),
  ...(choice.options ? { options: choice.options } : {}),
});

function ModelFix({ open, deps }: { open: BlockerOf<"model">; deps: FixDeps }) {
  const { blocker } = open;
  const { groups, current, differs, remember } = deps.models;
  const choices = groups.flatMap((group) => group.options);
  const [picked, setPicked] = useState(current);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const option = choices.find((one) => one.id === picked);
  const moving = !!option && (picked !== current || differs);
  // dot's model is trying again: only what it says next ends this.
  const trying = !deps.stall;
  const reason = modelBlock(deps.stall?.reason) ? deps.stall?.reason : blocker.reason;
  const detail = deps.stall?.detail ?? blocker.detail;
  const words = MODEL_WORDS[reason ?? blocker.reason] ?? MODEL_WORDS[STALL.modelUnavailable];
  const text =
    deps.local && reason === STALL.modelUnavailable
      ? `The local model isn't answering. Start its server and load the model, then try again, ${ANOTHER}.`
      : words?.text;
  const go = async () => {
    setSending(true);
    setProblem(null);
    try {
      if (moving && option) {
        if (!(await remember(option))) throw new Error("not saved");
        await deps.api.post(
          `/api/agent/sessions/${deps.sessionId}/blockers/${open.blockerId}/model`,
          { model: refOf(option) },
        );
      } else if (!(await deps.retry.run())) throw new Error("not resumed");
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 400
          ? "dot can't use that model right now. Choose another."
          : "That didn't go through. Try again.",
      );
    } finally {
      setSending(false);
    }
  };
  return (
    <Shell kind="model" title={words?.title ?? "The model can't go on"}>
      <p className="thread-recovery-text">{text}</p>
      {detail && <p className="thread-recovery-reason">The provider said: {detail}</p>}
      {deps.planResets && (
        <p className="thread-recovery-reason">
          {deps.planResets.replace(/^Resets/, "Your plan's limit resets")}.
        </p>
      )}
      {choices.length > 1 && (
        <Select
          aria-label="Model"
          value={picked ?? ""}
          groups={groups.map((group) => ({
            label: group.label,
            items: group.options.map((one) => ({ value: one.id, label: one.name })),
          }))}
          onValueChange={setPicked}
        />
      )}
      {problem && (
        <p className="thread-recovery-reason" role="alert">
          {problem}
        </p>
      )}
      <div className="thread-recovery-actions">
        <Button
          variant="primary"
          busy={sending || trying}
          disabledReason={moving ? undefined : deps.retry.reason}
          onClick={() => void go()}
        >
          {trying ? "Trying again…" : moving ? `Continue with ${option?.name}` : "Try again"}
        </Button>
      </div>
    </Shell>
  );
}

function ComputerFix({ open, deps }: { open: BlockerOf<"computer">; deps: FixDeps }) {
  const paused = open.blocker.state === "paused";
  const { action, run } = deps.computer;
  // A computer on its way back offers to stop instead: it needs nothing from here but time.
  const offered = action && action.kind !== "stop" ? action : undefined;
  return (
    <Shell kind="computer" title={paused ? "Your computer is paused" : "Your computer is off"}>
      <p className="thread-recovery-text">
        dot needs it to go on. Turn it back on and dot carries on by itself.
      </p>
      <div className="thread-recovery-actions">
        <Button
          variant="primary"
          icon="power"
          busy={!offered || !!offered.busy}
          disabledReason={!offered || offered.enabled ? undefined : "Wait a moment"}
          onClick={() => offered && run(offered.kind)}
        >
          {!offered
            ? "Turning on…"
            : offered.kind === "resume"
              ? "Resume"
              : offered.kind === "retry"
                ? "Try again"
                : "Turn on"}
        </Button>
        <NotNow open={open} deps={deps} />
      </div>
    </Shell>
  );
}

function RuntimeFix({ open, deps }: { open: BlockerOf<"runtime">; deps: FixDeps }) {
  const [state, setState] = useState<"idle" | "starting" | "waiting" | "manual">("idle");
  const start = async () => {
    setState("starting");
    try {
      const { started } = await deps.api.post<{ started: boolean }>("/api/runtime/start");
      setState(started ? "waiting" : "manual");
      deps.runtimeChanged();
    } catch {
      setState("manual");
    }
  };
  return (
    <Shell kind="runtime" title="Docker isn't running">
      <p className="thread-recovery-text">
        {state === "waiting"
          ? "Docker is starting. dot carries on by itself as soon as it's up."
          : state === "manual"
            ? "localDot couldn't start it from here. Start Docker on the computer running localDot, and dot carries on by itself."
            : "Docker runs your computer. Start it and dot carries on by itself."}
      </p>
      <div className="thread-recovery-actions">
        <Button
          variant="primary"
          icon="power"
          busy={state === "starting" || state === "waiting"}
          onClick={() => void start()}
        >
          {state === "waiting"
            ? "Starting Docker…"
            : state === "manual"
              ? "Try again"
              : "Start Docker"}
        </Button>
        <NotNow open={open} deps={deps} />
      </div>
    </Shell>
  );
}

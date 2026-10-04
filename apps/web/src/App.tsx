import { LLM_PROVIDERS } from "@localdot/protocol";
import { providerById } from "@localdot/providers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AskForm } from "./agent/AskForm.tsx";
import { Composer } from "./agent/Composer.tsx";
import { StopControl } from "./agent/StopControl.tsx";
import { type PointerMode, TakeoverPanel } from "./agent/TakeoverPanel.tsx";
import { useAgentSession } from "./agent/useAgentSession.ts";
import { useTaskControls } from "./agent/useTaskControls.ts";
import { hudFor } from "./cells/hud-state.ts";
import { useCell } from "./cells/useCell.ts";
import type { KeyFormPreset, KeyIntake } from "./keys/KeyForm.tsx";
import { KeysSheet } from "./keys/KeysSheet.tsx";
import { keyStatus, useKeys } from "./keys/useKeys.ts";
import { type ApiClient, ApiError, createApi } from "./lib/api.ts";
import { forgetToken, keepToken, storedToken, takeFragmentToken } from "./lib/token.ts";
import { timelineRows } from "./session/key-uses.ts";
import { mergeHud, sessionHud, stepRows } from "./session/session-view.ts";
import { useLiveSession } from "./session/useLiveSession.ts";
import { useNowMs } from "./session/useNowMs.ts";
import { matchingKeys } from "./settings/choices.ts";
import { SettingsSheet } from "./settings/SettingsSheet.tsx";
import { needsPrice, pickerKeys } from "./settings/settings-form.ts";
import { useSettings } from "./settings/useSettings.ts";
import { ConversationRail } from "./shell/ConversationRail.tsx";
import { Hud } from "./shell/Hud.tsx";
import { PaneTabs, type TheatrePane } from "./shell/PaneTabs.tsx";
import { PlanRail } from "./shell/PlanRail.tsx";
import { StageColumn } from "./shell/StageColumn.tsx";
import { TopBar } from "./shell/TopBar.tsx";
import { Stage, type StageHandle } from "./stage/Stage.tsx";
import "./app.css";

export interface AppProps {
  fetchImpl?: typeof fetch;
}

type Rejected = "stored" | "link" | null;

const RETRY_CHECK_MS = 2000;

export function App({ fetchImpl }: AppProps) {
  const [token, setToken] = useState(() => storedToken());
  // A token from a link, used and stored only once the daemon accepts it, so a wrong link can't
  // log the user out.
  const [candidate, setCandidate] = useState(() => takeFragmentToken());
  const [rejected, setRejected] = useState<Rejected>(null);
  const tokenOwner = useRef(token);

  // Opening the daemon's link in a tab that already shows this page changes only the fragment,
  // which the browser does not reload for.
  useEffect(() => {
    const onHashChange = () => {
      const given = takeFragmentToken();
      if (given) setCandidate(given);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!candidate) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      createApi(candidate, { fetchImpl })
        .get("/api/whoami")
        .then(
          () => {
            if (cancelled) return;
            keepToken(candidate);
            tokenOwner.current = candidate;
            setToken(candidate);
            setRejected(null);
            setCandidate(null);
          },
          (err: unknown) => {
            if (cancelled) return;
            if (err instanceof ApiError && err.status === 401) {
              setRejected("link");
              setCandidate(null);
              return;
            }
            // No answer: the daemon may be restarting.
            timer = setTimeout(check, RETRY_CHECK_MS);
          },
        );
    };
    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [candidate, fetchImpl]);

  const api = useMemo<ApiClient | null>(
    () =>
      token
        ? createApi(token, {
            fetchImpl,
            // A 401 that arrives after a newer token took over leaves that token alone.
            onUnauthorized: () => {
              if (tokenOwner.current !== token) return;
              tokenOwner.current = null;
              forgetToken(token);
              setRejected("stored");
              setToken((current) => (current === token ? null : current));
            },
          })
        : null,
    [token, fetchImpl],
  );

  if (api) return <Theatre key={token} api={api} />;
  if (candidate) {
    return (
      <p className="notice" role="status">
        Checking the link…
      </p>
    );
  }
  return <NoToken rejected={rejected} />;
}

function Theatre({ api }: { api: ApiClient }) {
  const { cell, status, pending, error, listed, reconnects, start, stop, resume, retry } =
    useCell(api);
  const keys = useKeys(api);
  const settings = useSettings(api);
  const mainProvider = settings.saved?.main && providerById(settings.saved.main.provider);
  const mainReady =
    settings.mainReady &&
    !!mainProvider &&
    (mainProvider.local === true ||
      (keys.metadataReady === true &&
        keys.health?.online === true &&
        matchingKeys(mainProvider, keys.keys).some((key) => key.id === settings.saved?.main?.key)));
  const [keysOpen, setKeysOpen] = useState(false);
  const keysButton = useRef<HTMLButtonElement>(null);
  const keysIntake = useRef<KeyIntake>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsOrigin = useRef<HTMLElement | null>(null);
  const keysOrigin = useRef<HTMLElement | null>(null);
  const [keyPreset, setKeyPreset] = useState<KeyFormPreset | undefined>();
  const keyRequest = useRef(0);
  const keyCapture = useRef<{
    request: number;
    capture: ReturnType<typeof settings.captureKey>;
  } | null>(null);
  const showSettings = (trigger: HTMLElement) => {
    settingsOrigin.current = trigger;
    settings.show();
  };
  const receiveKey = useCallback<KeyIntake["receive"]>((source, provider) => {
    keysOrigin.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keyCapture.current = null;
    flushSync(() => {
      setKeyPreset(undefined);
      setKeysOpen(true);
    });
    return keysIntake.current?.receive(source, provider) ?? false;
  }, []);
  const wasOpen = useRef(false);
  const closeKeys = useCallback(() => setKeysOpen(false), []);
  useEffect(() => {
    // Restore only after the render has removed inert from the Theatre.
    if (wasOpen.current && !keysOpen) {
      if (keysOrigin.current?.isConnected && !keysOrigin.current.closest("[inert], [hidden]"))
        keysOrigin.current.focus();
      else if (!settings.open) keysButton.current?.focus();
    }
    wasOpen.current = keysOpen;
  }, [keysOpen, settings.open]);
  const wasSettingsOpen = useRef(false);
  useEffect(() => {
    if (wasSettingsOpen.current && !settings.open && !keysOpen) {
      if (
        settingsOrigin.current?.isConnected &&
        !settingsOrigin.current.closest("[inert], [hidden]")
      )
        settingsOrigin.current.focus();
      else settingsButton.current?.focus();
    }
    wasSettingsOpen.current = settings.open;
  }, [settings.open, keysOpen]);
  const hud = hudFor({ cell, status, pending });
  const stage = useRef<StageHandle>(null);
  const session = useLiveSession(api, cell, stage);
  const agent = useAgentSession(api, cell, session);
  const [pane, setPane] = useState<TheatrePane>("computer");
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(width < 1180px)").matches ?? false,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia("(width < 1180px)");
    const changed = () => setNarrow(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const controls = useTaskControls({
    api,
    cell,
    cellPending: pending,
    agent,
    feed: session.agentFeed,
    suspended: keysOpen || settings.open,
    manualVisible: !narrow || pane === "computer",
    refreshCell: retry,
  });
  const [pointerMode, setPointerMode] = useState<PointerMode>("click");
  useEffect(() => {
    if (agent.model.pendingTakeover) setPointerMode("click");
  }, [agent.model.pendingTakeover]);
  const question =
    !controls.fenced &&
    !agent.model.ended &&
    agent.model.pendingAsk &&
    (!agent.fresh || agent.snapshot?.pendingAsk === agent.model.pendingAsk)
      ? agent.model.questions.get(agent.model.pendingAsk)
      : undefined;
  const takeover =
    !controls.fenced &&
    !agent.model.ended &&
    agent.model.pendingTakeover &&
    (!agent.fresh || agent.snapshot?.pendingTakeover === agent.model.pendingTakeover)
      ? agent.model.takeovers.get(agent.model.pendingTakeover)
      : undefined;
  const guardStart = () => {
    if (
      !controls.stopping &&
      !controls.busy &&
      controls.stopStatus.phase !== "unconfirmed" &&
      (controls.stopStatus.phase !== "stopped" || hud.action.kind === "start") &&
      !agent.model.pendingTakeover
    )
      start();
  };
  const guardResume = () => {
    if (
      !controls.stopping &&
      !controls.busy &&
      controls.stopStatus.phase !== "unconfirmed" &&
      cell?.state === "ready" &&
      cell.paused &&
      !agent.model.pendingTakeover
    )
      resume();
  };
  const guardComputerStop = () => {
    if (!controls.stopping && !controls.busy) stop();
  };
  const taskStop = () => {
    void controls.stop();
  };
  const stageCell =
    cell && controls.stopStatus.phase === "paused"
      ? { ...cell, paused: true as const }
      : cell && controls.stopStatus.phase === "stopped"
        ? { ...cell, state: "stopped" as const }
        : cell;
  const containedHud =
    controls.stopStatus.phase === "paused" || controls.stopStatus.phase === "stopped"
      ? hudFor({ cell: stageCell, status, pending })
      : hud;
  const now = useNowMs(session.model, session.version);
  const sHud = session.sessionId ? sessionHud(session.model, now) : null;
  const sessionMerged = mergeHud(
    error ? { ...containedHud, caption: error } : containedHud,
    controls.stopStatus.phase === "paused" || controls.stopStatus.phase === "stopped" ? null : sHud,
  );
  const merged = {
    ...sessionMerged,
    ...(controls.stopping
      ? { label: "Stopping…", stop: true }
      : controls.stopStatus.phase === "unconfirmed"
        ? { label: "Stop unconfirmed", stop: true }
        : {}),
    action: {
      ...sessionMerged.action,
      enabled:
        sessionMerged.action.enabled &&
        !controls.stopping &&
        !controls.busy &&
        controls.stopStatus.phase !== "unconfirmed" &&
        (sessionMerged.action.kind !== "resume" ||
          (cell?.state === "ready" && cell.paused === true && !agent.model.pendingTakeover)) &&
        (sessionMerged.action.kind !== "start" ||
          controls.stopStatus.phase !== "stopped" ||
          hud.action.kind === "start"),
    },
    control: Boolean(
      sessionMerged.control &&
        !controls.fenced &&
        agent.fresh &&
        !agent.model.pendingTakeover &&
        !agent.snapshot?.pendingTakeover,
    ),
  };
  const rows = session.sessionId
    ? timelineRows(stepRows(session.model), session.model.keyUses)
    : [];
  useEffect(() => {
    document.title = `localDot — ${merged.label}`;
  }, [merged.label]);
  return (
    <div className={merged.control ? "app control" : "app"}>
      <div className="theatre-content" inert={keysOpen || settings.open}>
        <TopBar
          title={session.model.title ?? "Your computer"}
          live={hud.live}
          keys={keyStatus(keys.health)}
          keysOpen={keysOpen}
          onKeys={() => {
            keysOrigin.current = keysButton.current;
            keyCapture.current = null;
            setKeyPreset(undefined);
            setKeysOpen(true);
          }}
          keysRef={keysButton}
          settings={{ open: settings.open, run: showSettings, ref: settingsButton }}
        />
        <div className="task-bar">
          <Hud
            hud={merged}
            onStart={guardStart}
            onStop={guardComputerStop}
            onResume={guardResume}
            onStopSession={taskStop}
            stopping={controls.stopping}
            stopEnabled={controls.canStop}
            onRetry={retry}
          />
          {session.sessionId && (
            <span className="task-connection">
              {agent.error
                ? "Activity unavailable"
                : agent.connection === "lost"
                  ? "Connection lost"
                  : agent.connection === "connecting"
                    ? "Connecting…"
                    : agent.snapshot?.status === "idle"
                      ? "Ready for follow-up"
                      : agent.model.pendingTakeover
                        ? "Your turn"
                        : agent.model.pendingAsk
                          ? "Waiting for you"
                          : "Task activity"}
            </span>
          )}
        </div>
        <StopControl controls={controls} />
        <PaneTabs
          selected={pane}
          onSelect={setPane}
          waiting={Boolean(agent.model.pendingAsk || agent.model.pendingTakeover)}
        />
        <div className="house">
          <div
            className="pane pane-conversation"
            id="pane-conversation"
            role="tabpanel"
            aria-label="Conversation"
            data-selected={pane === "conversation"}
            inert={narrow && pane !== "conversation"}
            onFocusCapture={() => {
              if (!narrow) setPane("conversation");
            }}
          >
            <ConversationRail
              visible={!narrow || pane === "conversation"}
              agent={agent}
              composer={
                <>
                  {question && !agent.model.ended && (
                    <AskForm
                      key={question.askId}
                      question={question}
                      controls={controls}
                      visible={(!narrow || pane === "conversation") && !keysOpen && !settings.open}
                      receiveKey={receiveKey}
                    />
                  )}
                  <Composer
                    api={api}
                    cell={cell}
                    known={status === "known"}
                    pending={pending !== null}
                    controlBlocked={controls.fenced || controls.stopping}
                    agent={agent}
                    keysOpen={keysOpen || settings.open}
                    receiveKey={receiveKey}
                    configured={mainReady}
                    onSettings={showSettings}
                    modelSummary={
                      settings.saved?.main
                        ? `Saved main: ${providerById(settings.saved.main.provider)?.name ?? settings.saved.main.provider} · ${settings.saved.main.model}`
                        : "Choose a main model in Settings before starting a task."
                    }
                  />
                </>
              }
            />
          </div>
          <div
            className={
              takeover && !agent.model.ended
                ? "pane pane-computer manual-pane"
                : "pane pane-computer"
            }
            id="pane-computer"
            role="tabpanel"
            aria-label="Computer"
            data-selected={pane === "computer"}
            inert={narrow && pane !== "computer"}
            onFocusCapture={() => {
              if (!narrow) setPane("computer");
            }}
          >
            <StageColumn
              before={
                takeover && !agent.model.ended ? (
                  <TakeoverPanel
                    key={takeover.requestId}
                    takeover={takeover}
                    controls={controls}
                    visible={(!narrow || pane === "computer") && !keysOpen && !settings.open}
                    manualStatus={agent.snapshot?.manualControl}
                    receiveKey={receiveKey}
                    screen={session.model.screen}
                    pointerMode={pointerMode}
                    onPointerMode={setPointerMode}
                  />
                ) : undefined
              }
              showHud={false}
              hud={merged}
              control={merged.control}
              onStart={guardStart}
              onStop={guardComputerStop}
              onResume={guardResume}
              onStopSession={taskStop}
              onRetry={retry}
            >
              <Stage
                ref={stage}
                cell={stageCell}
                api={api}
                control={merged.control}
                reconnects={reconnects}
                listed={listed}
                manual={
                  takeover && session.model.screen && !agent.model.ended
                    ? {
                        requestId: takeover.requestId,
                        enabled: controls.canInput,
                        screen: session.model.screen,
                        button: pointerMode === "right" ? "right" : "left",
                        count: pointerMode === "double" ? 2 : 1,
                        input: controls.input,
                      }
                    : undefined
                }
              />
            </StageColumn>
          </div>
          <div
            className="pane pane-activity"
            id="pane-activity"
            role="tabpanel"
            aria-label="Activity"
            data-selected={pane === "activity"}
            inert={narrow && pane !== "activity"}
            onFocusCapture={() => {
              if (!narrow) setPane("activity");
            }}
          >
            <PlanRail
              agent={agent.model}
              rows={rows}
              keyUses={session.model.keyUses}
              sessionId={session.sessionId}
              scale={cell?.scale ?? 2}
              api={api}
              title={session.model.title}
            />
          </div>
        </div>
      </div>
      <SettingsSheet
        taskControls={<StopControl controls={controls} />}
        open={settings.open}
        suspended={keysOpen}
        choices={settings.draft?.choices ?? {}}
        providers={settings.index?.providers ?? []}
        keys={settings.index ? pickerKeys(settings.index) : []}
        keyLayer={settings.index?.keyLayer ?? "unknown"}
        catalog={
          settings.phase === "refreshing"
            ? "refreshing"
            : settings.phase === "loading"
              ? "loading"
              : settings.phase === "error"
                ? "offline"
                : !settings.index?.catalog
                  ? "empty"
                  : Date.now() - Date.parse(settings.index.catalog.fetchedAt) > 86_400_000
                    ? "stale"
                    : "ready"
        }
        dirty={settings.dirty}
        busy={settings.busy}
        loading={settings.phase === "loading" || !settings.draft}
        error={settings.error}
        validation={settings.validation}
        onClose={settings.close}
        onChange={settings.change}
        onKeys={(role, providerId, trigger) => {
          const provider = providerById(providerId);
          if (
            !provider ||
            provider.local ||
            provider.availableIn ||
            !settings.open ||
            settings.busy ||
            !LLM_PROVIDERS.some((kind) => kind === provider.keyd)
          )
            return;
          const request = ++keyRequest.current;
          keyCapture.current = { request, capture: settings.captureKey(role, providerId) };
          keysOrigin.current = trigger;
          setKeyPreset({
            requestId: request,
            provider: provider.keyd as (typeof LLM_PROVIDERS)[number],
            ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
          });
          setKeysOpen(true);
        }}
        onRefresh={() => void settings.refresh()}
        onReload={settings.reload}
        save={{ enabled: settings.saveEnabled && settings.dirty, run: () => void settings.save() }}
        manualPrices={Object.fromEntries(
          (["main", "fast", "local"] as const)
            .filter(
              (role) =>
                needsPrice(settings.draft?.choices[role], settings.index) &&
                (role === "main" || settings.draft?.choices.main?.provider !== "chatgpt"),
            )
            .map((role) => [role, settings.draft?.prices[role] ?? { input: "", output: "" }]),
        )}
        onPrice={settings.changePrice}
        budget={
          settings.draft
            ? {
                value: settings.draft.budget,
                useDefault: settings.draft.defaultBudget,
                defaultUSD: settings.index?.defaultTaskBudgetUSD ?? null,
                change: settings.budget,
              }
            : undefined
        }
        stop={
          merged.stop
            ? {
                label: controls.stopping ? "Stopping…" : "Stop",
                enabled: controls.canStop && !controls.stopping,
                run: taskStop,
              }
            : merged.action.kind === "stop" || merged.action.kind === "resume"
              ? { label: "Stop computer", enabled: merged.action.enabled, run: guardComputerStop }
              : undefined
        }
      />
      <KeysSheet
        taskControls={<StopControl controls={controls} />}
        intakeRef={keysIntake}
        open={keysOpen}
        keys={keys}
        onClose={closeKeys}
        preset={keyPreset}
        onSaved={(key, request) => {
          const context = keyCapture.current;
          if (context?.request === request) void settings.keySaved(context.capture, key);
        }}
        stop={
          merged.stop
            ? {
                label: controls.stopping ? "Stopping…" : "Stop",
                enabled: controls.canStop && !controls.stopping,
                run: taskStop,
              }
            : merged.action.kind === "stop" || merged.action.kind === "resume"
              ? { label: "Stop computer", enabled: merged.action.enabled, run: guardComputerStop }
              : undefined
        }
      />
    </div>
  );
}

const REJECTED: Record<Exclude<Rejected, null>, string> = {
  stored: "The daemon rejected the stored token.",
  link: "The daemon rejected the token in the link.",
};

function NoToken({ rejected }: { rejected: Rejected }) {
  return (
    <section className="notice" role="alert">
      <h1>No access token</h1>
      <p>
        {rejected ? REJECTED[rejected] : "This page needs the install token."} Open the link the
        daemon printed at startup: <code>{window.location.origin}/#token=…</code>
      </p>
    </section>
  );
}

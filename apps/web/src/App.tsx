import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Composer } from "./agent/Composer.tsx";
import { useAgentSession } from "./agent/useAgentSession.ts";
import { hudFor } from "./cells/hud-state.ts";
import { useCell } from "./cells/useCell.ts";
import type { KeyIntake } from "./keys/KeyForm.tsx";
import { KeysSheet } from "./keys/KeysSheet.tsx";
import { keyStatus, useKeys } from "./keys/useKeys.ts";
import { type ApiClient, ApiError, createApi } from "./lib/api.ts";
import { forgetToken, keepToken, storedToken, takeFragmentToken } from "./lib/token.ts";
import { timelineRows } from "./session/key-uses.ts";
import { mergeHud, sessionHud, stepRows } from "./session/session-view.ts";
import { useLiveSession } from "./session/useLiveSession.ts";
import { useNowMs } from "./session/useNowMs.ts";
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
  const [keysOpen, setKeysOpen] = useState(false);
  const keysButton = useRef<HTMLButtonElement>(null);
  const keysIntake = useRef<KeyIntake>(null);
  const receiveKey = useCallback<KeyIntake["receive"]>((source, provider) => {
    flushSync(() => setKeysOpen(true));
    return keysIntake.current?.receive(source, provider) ?? false;
  }, []);
  const wasOpen = useRef(false);
  const closeKeys = useCallback(() => setKeysOpen(false), []);
  useEffect(() => {
    // Restore only after the render has removed inert from the Theatre.
    if (wasOpen.current && !keysOpen) keysButton.current?.focus();
    wasOpen.current = keysOpen;
  }, [keysOpen]);
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
  const now = useNowMs(session.model, session.version);
  const sHud = session.sessionId ? sessionHud(session.model, now) : null;
  const sessionMerged = mergeHud(error ? { ...hud, caption: error } : hud, sHud);
  const merged = {
    ...sessionMerged,
    control: Boolean(
      sessionMerged.control &&
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
      <div className="theatre-content" inert={keysOpen}>
        <TopBar
          title={session.model.title ?? "Your computer"}
          live={hud.live}
          keys={keyStatus(keys.health)}
          keysOpen={keysOpen}
          onKeys={() => setKeysOpen((open) => !open)}
          keysRef={keysButton}
        />
        <div className="task-bar">
          <Hud
            hud={merged}
            onStart={start}
            onStop={stop}
            onResume={resume}
            onStopSession={session.stop}
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
                <Composer
                  api={api}
                  cell={cell}
                  known={status === "known"}
                  pending={pending !== null}
                  agent={agent}
                  keysOpen={keysOpen}
                  receiveKey={receiveKey}
                />
              }
            />
          </div>
          <div
            className="pane pane-computer"
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
              showHud={false}
              hud={merged}
              control={merged.control}
              onStart={start}
              onStop={stop}
              onResume={resume}
              onStopSession={session.stop}
              onRetry={retry}
            >
              <Stage
                ref={stage}
                cell={cell}
                api={api}
                control={merged.control}
                reconnects={reconnects}
                listed={listed}
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
              sessionId={session.sessionId}
              scale={cell?.scale ?? 2}
              api={api}
              title={session.model.title}
            />
          </div>
        </div>
      </div>
      <KeysSheet
        intakeRef={keysIntake}
        open={keysOpen}
        keys={keys}
        onClose={closeKeys}
        stop={
          merged.stop
            ? { label: "Stop", enabled: true, run: session.stop }
            : merged.action.kind === "stop" || merged.action.kind === "resume"
              ? { label: "Stop computer", enabled: merged.action.enabled, run: stop }
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

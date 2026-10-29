import type { SessionIndexPage } from "@localdot/protocol";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentMessage, AgentWords } from "../agent/model.ts";
import { SafeMarkdown } from "../agent/SafeMarkdown.tsx";
import { useAgentSession } from "../agent/useAgentSession.ts";
import { useConversation } from "../agent/useConversation.ts";
import { useBrowserScreen } from "../cells/useBrowserScreen.ts";
import { useCell } from "../cells/useCell.ts";
import { DotLoader } from "../dot/DotLoader.tsx";
import type { ApiClient } from "../lib/api.ts";
import { ReplayControls } from "../replay/ReplayControls.tsx";
import { useReplay } from "../replay/useReplay.ts";
import { useLiveSession } from "../session/useLiveSession.ts";
import type { ShareLink } from "../settings/ShareLinkControls.tsx";
import { type ScreenName, useStageConnection, useStagePicture } from "../stage/connection.ts";
import { Stage, type StageHandle } from "../stage/Stage.tsx";
import { awayWords } from "../stage/StageNotice.tsx";
import { Announcer } from "../ui/Announcer.tsx";
import { Button } from "../ui/Button.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Select } from "../ui/Select.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { TextArea } from "../ui/TextArea.tsx";
import "../ui/shared.css";

type Guest = ShareLink & { ownedSessions: string[] };
export function SharedApp({ api }: { api: ApiClient }) {
  const [grant, setGrant] = useState<Guest | null>(null);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [settings, setSettings] = useState(false);
  const [recordings, setRecordings] = useState<SessionIndexPage | null>(null);
  const [replayId, setReplayId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const computer = useCell(api);
  const stage = useRef<StageHandle>(null);
  const conversation = useConversation(api);
  const live = useLiveSession(
    api,
    computer.cell,
    stage,
    conversation.known ? (conversation.sessions.at(-1) ?? null) : undefined,
    conversation.choice,
  );
  const agent = useAgentSession(api, computer.cell, live);
  const selection = agent.watchScreen ?? agent.snapshot?.screen;
  const browser = useBrowserScreen(api, computer.cell, selection);
  const watchingBrowser = selection?.screen === "browser";
  const shown = watchingBrowser ? browser.cell : computer.cell;
  const screenName: ScreenName = watchingBrowser ? "browser" : "desktop";
  const parent = computer.cell;
  const { picture, onPicture } = useStagePicture(screenName, shown?.state === "ready");
  const connection = useStageConnection({
    computer:
      parent?.state === "ready" && !parent.fenced && !parent.replacementPending ? parent.id : null,
    screen: screenName,
    picture,
    screenUp: !shown || shown.state === "ready",
    resting: !!replayId || !!parent?.paused,
  });
  const away =
    connection.phase === "away" && connection.level !== "blip" && connection.cause !== "switch"
      ? awayWords(connection.cause, connection.screen).brief
      : null;
  const status = agent.snapshot?.status;
  const owns = !!live.sessionId && !!grant?.ownedSessions.includes(live.sessionId);
  const working = status === "running" || status === "starting";
  const blocked =
    !!agent.snapshot &&
    (status === "waiting_user" ||
      status === "paused" ||
      !!agent.snapshot.holder ||
      !!agent.snapshot.manualControl);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly refreshes the server-issued grant after a mutation
  useEffect(() => {
    const abort = new AbortController();
    let busy = false;
    const load = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const value = await api.get<Guest>("/api/remote-session", { signal: abort.signal });
        if (!abort.signal.aborted) {
          setGrant(value);
          setConnectionError(false);
        }
      } catch {
        if (!abort.signal.aborted) setConnectionError(true);
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [api, revision]);
  const send = async () => {
    if (sending || !text.trim() || !computer.cell || !grant) return;
    setSending(true);
    setError("");
    try {
      if (owns && live.sessionId && status !== "ended")
        await api.post(`/api/agent/sessions/${live.sessionId}/messages`, {
          text: text.trim(),
          kind: working ? "steer" : "followup",
        });
      else await api.post(`/api/cells/${computer.cell.id}/agent`, { task: text.trim() });
      setText("");
      setRevision((n) => n + 1);
      live.check();
      conversation.reload();
      agent.reconcile();
    } catch {
      setError(
        "The message could not be sent. Check the task status, connection and link limits before trying again.",
      );
    } finally {
      setSending(false);
    }
  };
  const loadRecordings = async () => {
    try {
      setRecordings(await api.get<SessionIndexPage>("/api/session-index?limit=50"));
    } catch {
      setError("Recordings could not load.");
    }
  };
  const modelPicker = grant?.chooseModel && (
    <Select
      aria-label="Model"
      value={String(
        grant.models.findIndex((m) => JSON.stringify(m) === JSON.stringify(grant.model)),
      )}
      items={grant.models.map((m, i) => ({ value: String(i), label: m.model }))}
      onValueChange={(value) => {
        void api
          .post("/api/remote-session/model", { index: Number(value) })
          .then(() => setRevision((n) => n + 1))
          .catch(() => setError("The model could not be changed."));
      }}
    />
  );
  return (
    <main className="shared-app">
      <header>
        <strong>localDot</strong>
        <span>{grant?.label ?? "Connecting…"}</span>
        <div className="shared-actions">
          {grant?.replay && (
            <Button variant="quiet" onClick={() => void loadRecordings()}>
              Replays
            </Button>
          )}
          {grant?.settings && (
            <Button variant="quiet" onClick={() => setSettings(true)}>
              Settings
            </Button>
          )}
        </div>
      </header>
      <div className="shared-screen stage lit">
        {replayId ? (
          <SharedReplay key={replayId} api={api} id={replayId} onClose={() => setReplayId(null)} />
        ) : (
          <>
            <Stage
              ref={stage}
              api={api}
              cell={shown}
              parentId={watchingBrowser ? computer.cell?.id : undefined}
              selection={watchingBrowser ? selection : undefined}
              reconnects={watchingBrowser ? browser.reconnects : computer.reconnects}
              listed={computer.listed}
              onPicture={onPicture}
              connection={connection}
            />
            {connection.phase === "first" && (
              <div className="shared-screen-loading">
                <DotLoader
                  label={
                    computer.status !== "known" || !computer.cell
                      ? "Connecting to your computer…"
                      : computer.cell.state === "ready"
                        ? "Connecting your screen…"
                        : computer.cell.state === "starting"
                          ? "Starting your computer…"
                          : "Waiting for the owner to turn on the computer"
                  }
                />
              </div>
            )}
            <div className="shared-screen-status" role="status">
              {computer.status !== "known" || !computer.cell
                ? "Connecting to your computer…"
                : computer.cell.state !== "ready"
                  ? computer.cell.state === "starting"
                    ? "Starting your computer…"
                    : "Waiting for the owner to turn on the computer"
                  : (away ??
                    (parent?.paused ? "Paused" : watchingBrowser ? "Browser" : "Computer"))}
            </div>
          </>
        )}
      </div>
      <section className="shared-chat" aria-label="Conversation">
        <div className="shared-messages">
          {[...agent.model.messages.values()].slice(-50).map((message) => (
            <SharedMessage key={message.id} message={message} feed={live.agentFeed} />
          ))}
          {!agent.model.messages.size && <p>What would you like dot to do?</p>}
        </div>
        <Disclosure
          className="shared-progress"
          summary={`${agent.snapshot?.toolCalls ?? 0} steps · ${status ?? "Ready"}`}
        >
          <ol>
            {[...agent.model.steps.values()].slice(-50).map((step) => (
              <li key={step.id}>
                {step.intent ?? step.tool?.title ?? step.kind} · {step.status ?? "Working"}
              </li>
            ))}
          </ol>
        </Disclosure>
        {blocked && (
          <p role="status">
            This task needs the computer owner’s input or approval. It has not finished.
          </p>
        )}
        {connectionError && <p role="status">Access could not be checked. Reconnecting…</p>}
        {error && <p role="alert">{error}</p>}
        <form
          className="shared-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <TextArea
            aria-label="Message dot"
            placeholder="Message dot"
            value={text}
            maxLength={8000}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="shared-actions">
            {modelPicker || <span>{grant?.model.model}</span>}
            <Button
              variant="quiet"
              disabledReason={working || blocked ? "Finish the current task first" : undefined}
              onClick={() => void conversation.startNew()}
            >
              New chat
            </Button>
            {owns && working && (
              <Button
                variant="quiet"
                onClick={() => {
                  void api
                    .post(`/api/agent/sessions/${live.sessionId}/stop`)
                    .then(() => agent.reconcile())
                    .catch(() => setError("The task could not be stopped."));
                }}
              >
                Stop
              </Button>
            )}
            <Button
              type="submit"
              busy={sending}
              disabledReason={
                !grant || !text.trim()
                  ? "Enter a message"
                  : blocked
                    ? "Waiting for the owner"
                    : working && !owns
                      ? "Another task is running"
                      : computer.cell?.state !== "ready" || computer.cell.paused
                        ? "The computer is not ready"
                        : !agent.fresh && live.sessionId && !live.resting
                          ? "Checking task status"
                          : undefined
              }
            >
              Send
            </Button>
          </div>
        </form>
      </section>
      <Sheet
        open={settings}
        onClose={() => setSettings(false)}
        title="Chat settings"
        detents={["large"]}
      >
        <div className="shared-settings">
          {modelPicker}
          <p>
            {grant?.tasks} of {grant?.maxTasks ?? "unlimited"} tasks used.
          </p>
          <p>
            API budget: ${grant?.taskBudgetUSD} per task. Subscription usage follows the account’s
            allowance.
          </p>
          <p>
            {grant?.expiresAt
              ? `Access ends ${new Date(grant.expiresAt).toLocaleString()}.`
              : "Access lasts until the owner revokes it."}
          </p>
          <p>The owner manages this computer and its saved keys.</p>
        </div>
      </Sheet>
      <Sheet
        open={recordings !== null}
        onClose={() => setRecordings(null)}
        title="Replays"
        detents={["large"]}
      >
        <div className="shared-recordings">
          {recordings?.sessions.map((card) => (
            <Button
              key={card.id}
              variant="quiet"
              onClick={() => {
                setReplayId(card.id);
                setRecordings(null);
              }}
            >
              {card.title ?? new Date(card.startedAt).toLocaleString()}
            </Button>
          ))}
          {recordings?.next && (
            <Button
              onClick={() => {
                void api
                  .get<SessionIndexPage>(
                    `/api/session-index?limit=50&before=${encodeURIComponent(recordings.next ?? "")}`,
                  )
                  .then(setRecordings)
                  .catch(() => setError("More recordings could not load."));
              }}
            >
              Older recordings
            </Button>
          )}
          {recordings?.sessions.length === 0 && <p>No recordings yet.</p>}
        </div>
      </Sheet>
      <Announcer />
    </main>
  );
}
function SharedMessage({ message, feed }: { message: AgentMessage; feed: AgentWords }) {
  const live = useSyncExternalStore(
    feed.subscribeWords,
    () => feed.read().model.messages.get(message.id) ?? message,
  );
  return (
    <article data-role={live.role}>
      <strong>{live.role === "user" ? "You" : "dot"}</strong>
      <SafeMarkdown text={live.text} streaming={!live.final} />
    </article>
  );
}
function SharedReplay({ api, id, onClose }: { api: ApiClient; id: string; onClose(): void }) {
  const stage = useRef<StageHandle>(null);
  const replay = useReplay(api, id, stage, { onGoLive: onClose, onExit: onClose });
  return (
    <>
      <Stage ref={stage} mode="replay" api={api} cell={null} reconnects={0} listed={[]} />
      <div className="shared-replay-head">
        <Button variant="glass" onClick={onClose}>
          Live screen
        </Button>
        <Select
          aria-label="Replay screen"
          value={replay.screenChoice}
          onValueChange={(value) => replay.setScreen(value as "auto" | "desktop" | "browser")}
          items={[
            { value: "auto", label: "Auto" },
            { value: "desktop", label: "Computer" },
            { value: "browser", label: "Browser" },
          ]}
        />
      </div>
      <ReplayControls api={api} replay={replay} compact />
      {replay.status === "error" && <Button onClick={replay.retry}>Retry recording</Button>}
    </>
  );
}

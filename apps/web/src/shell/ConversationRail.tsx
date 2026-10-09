import { type ReactNode, useMemo } from "react";
import { Conversation } from "../agent/Conversation.tsx";
import { leftToReplay, useEarlierThread } from "../agent/earlier.ts";
import type { LiveWork } from "../agent/LiveWorkLine.tsx";
import { threadItems, type WorkStep, withWork, workSteps } from "../agent/thread.ts";
import type { AgentSessionView } from "../agent/useAgentSession.ts";
import type { ApiClient } from "../lib/api.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { IconButton } from "../ui/IconButton.tsx";
import { Presence } from "../ui/Presence.tsx";
import "./conversation.css";

const NO_ROWS: TimelineRow<StepRowView>[] = [];
const NO_SESSIONS: readonly string[] = [];

export interface NewConversation {
  run(): void;
  // Why a new conversation can't start yet; the button keeps its place meanwhile.
  reason?: string;
}

export function NewConversationButton({ run, reason }: NewConversation) {
  return (
    <IconButton
      icon="square-pen"
      size={32}
      label="New conversation"
      disabledReason={reason}
      onClick={() => run()}
    />
  );
}

export function ConversationRail({
  agent,
  composer,
  answer,
  recovery,
  visible = true,
  rows = NO_ROWS,
  live = null,
  api = null,
  onReplay,
  onReplayTask,
  computerReady = false,
  sessions = NO_SESSIONS,
  more = false,
  newConversation,
  titled = true,
}: {
  agent?: AgentSessionView;
  composer?: ReactNode;
  answer?: ReactNode;
  recovery?: ReactNode;
  visible?: boolean;
  rows?: TimelineRow<StepRowView>[];
  live?: LiveWork | null;
  api?: ApiClient | null;
  onReplay?: () => void;
  onReplayTask?: (sessionId: string) => void;
  computerReady?: boolean;
  // The conversation's tasks, oldest first; the one shown is its latest.
  sessions?: readonly string[];
  // Older tasks of the conversation are left out of `sessions`.
  more?: boolean;
  newConversation?: NewConversation;
  // False where a tab names the rail: its title is left to screen readers.
  titled?: boolean;
}) {
  const model = agent?.model;
  const ended = model?.ended?.reason;
  const sessionId = agent?.sessionId ?? null;
  const steps = useMemo<WorkStep[]>(() => (model ? workSteps(rows, model) : []), [rows, model]);
  const items = useMemo(
    () =>
      model ? threadItems(model.messages.values(), model.questions.values(), model.results) : [],
    [model],
  );
  const working = !!live && live.phase !== "finished" && !ended;
  const thread = useMemo(() => withWork(items, steps, working), [items, steps, working]);
  const latest = useMemo(() => ({ sessionId, items: thread }), [sessionId, thread]);
  const earlier = useEarlierThread(api, sessions, latest);
  const shown = useMemo(() => {
    if (!earlier.length) return thread;
    const own = new Set(thread.map((item) => item.key));
    return [
      ...earlier.map((item) =>
        own.has(item.key) ? { ...item, key: `${item.key}@earlier` } : item,
      ),
      ...thread,
    ];
  }, [earlier, thread]);
  return (
    <aside className="rail conversation-rail" aria-label="Conversation">
      <div className={titled ? "rail-h" : "ui-visually-hidden"}>
        <h2>Conversation</h2>
      </div>
      <Presence show={!!newConversation && !!sessionId}>
        <span className="conversation-new">
          {newConversation && <NewConversationButton {...newConversation} />}
        </span>
      </Presence>
      <Conversation
        visible={visible}
        ownerKey={sessions[0] ?? sessionId ?? ""}
        items={shown}
        truncated={model?.historyTruncated ?? false}
        earlierInReplay={leftToReplay(sessions, sessionId, more)}
        live={working ? live : null}
        ended={ended}
        pendingAsk={model?.pendingAsk ?? null}
        api={api}
        sessionId={sessionId}
        recovery={recovery}
        error={agent?.error}
        onReplay={onReplay}
        onReplayTask={onReplayTask}
        computerReady={computerReady}
        composer={composer}
        answer={answer}
      />
    </aside>
  );
}

import { type ReactNode, useMemo } from "react";
import { Conversation } from "../agent/Conversation.tsx";
import { leftToReplay, useEarlierThread } from "../agent/earlier.ts";
import type { LiveWork } from "../agent/LiveWorkLine.tsx";
import type { SpendCall } from "../agent/model.ts";
import { threadItems, type WorkStep, withWork, workSteps } from "../agent/thread.ts";
import { billedPerCall } from "../agent/UsageFooter.tsx";
import type { AgentSessionView } from "../agent/useAgentSession.ts";
import type { ApiClient } from "../lib/api.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import { IconButton } from "../ui/IconButton.tsx";
import "./conversation.css";

const NO_SPEND: readonly SpendCall[] = [];

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
      icon="compose"
      size={32}
      label="New conversation"
      disabledReason={reason}
      onClick={() => run()}
    />
  );
}

// The conversation in the rail, with Activity (or another view) laid over it when chosen.
export function ChatThread({
  agent,
  composer,
  answer,
  cover,
  covered = false,
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
}: {
  agent?: AgentSessionView;
  composer?: ReactNode;
  answer?: ReactNode;
  cover?: ReactNode;
  covered?: boolean;
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
  const spends = model && billedPerCall(agent?.snapshot?.models) ? model.spendCalls : NO_SPEND;
  const thread = useMemo(
    () => withWork(items, steps, working, spends),
    [items, steps, working, spends],
  );
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
      cover={cover}
      covered={covered}
    />
  );
}

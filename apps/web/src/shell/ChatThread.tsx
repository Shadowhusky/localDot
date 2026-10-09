import { type ReactNode, useMemo } from "react";
import { Conversation } from "../agent/Conversation.tsx";
import { useEarlierThread } from "../agent/earlier.ts";
import type { LiveWork } from "../agent/LiveWorkLine.tsx";
import type { AgentWords, SpendCall } from "../agent/model.ts";
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
  ask,
  lead,
  trail,
  tools,
  pinned = false,
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
  computerUpdating = false,
  sessions = NO_SESSIONS,
  more = false,
  pending = false,
  start,
  reveal,
  words,
}: {
  agent?: AgentSessionView;
  composer?: ReactNode;
  // The fields of the question dot is waiting on, drawn under it in the thread.
  ask?: ReactNode;
  lead?: ReactNode;
  trail?: ReactNode;
  // A phone's control toolbar in the composer's place, while the user has the computer.
  tools?: ReactNode;
  pinned?: boolean;
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
  computerUpdating?: boolean;
  // The conversation's tasks, oldest first; the one shown is its latest.
  sessions?: readonly string[];
  // Older tasks of the conversation are left out of `sessions`.
  more?: boolean;
  // Which conversation and task the thread shows is not known yet.
  pending?: boolean;
  // In place of the empty thread's suggestions.
  start?: ReactNode;
  // Counts the conversations the user chose.
  reveal?: number;
  // A streaming message's new words, which redraw only that message.
  words?: AgentWords;
}) {
  const model = agent?.model;
  const ended = agent?.interrupted ? "interrupted" : model?.ended?.reason;
  const sessionId = agent?.sessionId ?? null;
  const steps = useMemo<WorkStep[]>(() => (model ? workSteps(rows, model) : []), [rows, model]);
  const items = useMemo(
    () =>
      model
        ? threadItems(
            model.messages.values(),
            model.questions.values(),
            model.results,
            model.takeovers.values(),
            model.routineProposals.values(),
            model.origin,
          )
        : [],
    [model],
  );
  const working = !!live && live.phase !== "finished" && !ended;
  const spends = model && billedPerCall(agent?.snapshot?.models) ? model.spendCalls : NO_SPEND;
  const thread = useMemo(
    () => withWork(items, steps, working, spends),
    [items, steps, working, spends],
  );
  const latest = useMemo(() => ({ sessionId, items: thread }), [sessionId, thread]);
  const earlier = useEarlierThread(api, sessions, latest, agent?.history ?? true);
  const before = earlier.items;
  const shown = useMemo(() => {
    if (!before.length) return thread;
    const own = new Set(thread.map((item) => item.key));
    return [
      ...before.map((item) => (own.has(item.key) ? { ...item, key: `${item.key}@earlier` } : item)),
      ...thread,
    ];
  }, [before, thread]);
  return (
    <Conversation
      visible={visible}
      ownerKey={sessions[0] ?? sessionId ?? ""}
      items={shown}
      truncated={model?.historyTruncated ?? false}
      loading={pending || earlier.opening}
      earlier={earlier}
      earlierInReplay={!!sessionId && more && !earlier.more}
      live={working ? live : null}
      ended={ended}
      pendingAsk={model?.pendingAsk ?? null}
      api={api}
      sessionId={sessionId}
      recovery={recovery}
      onReplay={onReplay}
      onReplayTask={onReplayTask}
      computerReady={computerReady}
      computerUpdating={computerUpdating}
      composer={composer}
      ask={ask}
      lead={lead}
      trail={trail}
      tools={tools}
      pinned={pinned}
      cover={cover}
      covered={covered}
      start={start}
      reveal={reveal}
      words={words}
    />
  );
}

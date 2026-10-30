import type { TaskModelSelection } from "@localdot/protocol";
import { type ReactNode, useMemo, useRef } from "react";
import { Conversation } from "../agent/Conversation.tsx";
import { useEarlierThread } from "../agent/earlier.ts";
import type { LiveWork } from "../agent/LiveWorkLine.tsx";
import type { AgentWords, SpendCall } from "../agent/model.ts";
import {
  type ModelRef,
  threadItems,
  type WorkStep,
  type WorkStepCache,
  withWork,
  workSteps,
} from "../agent/thread.ts";
import { billedPerCall } from "../agent/UsageFooter.tsx";
import type { AgentSessionView } from "../agent/useAgentSession.ts";
import type { ApiClient } from "../lib/api.ts";
import { type Previews, PreviewsScope } from "../previews/PreviewsContext.tsx";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import type { ModelNames } from "../settings/model-names.ts";
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

// Filled, so it reads as the conversation's first action rather than one more quiet icon.
export function NewConversationButton({ run, reason }: NewConversation) {
  return (
    <IconButton
      icon="compose"
      size={32}
      variant="filled"
      round
      label="New conversation"
      disabledReason={reason}
      onClick={() => run()}
    />
  );
}

// The task's main model, which names its turns when their calls said nothing.
function mainOf(selection: TaskModelSelection | undefined): ModelRef | undefined {
  if (!selection) return undefined;
  if (selection.kind !== "api") return { route: selection.kind, model: selection.model };
  const main = selection.roles.find((role) => role.role === "main");
  return main && { route: main.provider, model: main.model };
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
  suggestions,
  sessions = NO_SESSIONS,
  more = false,
  withdrawn,
  pending = false,
  start,
  reveal,
  words,
  names,
  scale,
  previews = null,
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
  // What an empty chat offers to start with, in the chosen dot's line of work.
  suggestions?: readonly string[];
  // The conversation's tasks, oldest first; the one shown is its latest.
  sessions?: readonly string[];
  // Older tasks of the conversation are left out of `sessions`.
  more?: boolean;
  // Messages Stop left unsent that the user took back to edit.
  withdrawn?: readonly string[];
  // Which conversation and task the thread shows is not known yet.
  pending?: boolean;
  // In place of the empty thread's suggestions.
  start?: ReactNode;
  // Counts the conversations the user chose.
  reveal?: number;
  // A streaming message's new words, which redraw only that message.
  words?: AgentWords;
  names?: ModelNames;
  // The computer's display scale, for the screenshots a step unfolds.
  scale?: number;
  // The owner's previews of the servers dot starts; none for anyone else.
  previews?: Previews | null;
}) {
  const model = agent?.model;
  const ended = agent?.interrupted ? "interrupted" : model?.ended?.reason;
  const sessionId = agent?.sessionId ?? null;
  const built = useRef<WorkStepCache>(new Map());
  const steps = useMemo<WorkStep[]>(
    () => (model ? workSteps(rows, model, built.current) : []),
    [rows, model],
  );
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
            model.dots,
          )
        : [],
    [model],
  );
  const working = !!live && live.phase !== "finished" && !ended;
  const selection = agent?.snapshot?.models;
  const spends = model && billedPerCall(selection) ? model.spendCalls : NO_SPEND;
  const usage = model?.usageCalls;
  const mainRoute = useMemo(() => mainOf(selection), [selection]);
  const thread = useMemo(
    () => withWork(items, steps, working, spends, { usage, main: mainRoute }),
    [items, steps, working, spends, usage, mainRoute],
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
  const conversation = (
    <Conversation
      visible={visible}
      suggestions={suggestions}
      ownerKey={sessions[0] ?? sessionId ?? ""}
      items={shown}
      truncated={model?.historyTruncated ?? false}
      loading={pending || earlier.opening}
      earlier={earlier}
      earlierInReplay={!!sessionId && more && !earlier.more}
      withdrawn={withdrawn}
      live={working ? live : null}
      ended={ended}
      pendingAsk={model?.pendingAsk ?? null}
      api={api}
      sessionId={sessionId}
      scale={scale}
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
      names={names}
    />
  );
  return <PreviewsScope value={previews}>{conversation}</PreviewsScope>;
}

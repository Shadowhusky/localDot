import { type ReactNode, useMemo } from "react";
import { activityRows, entryView, foldKeyUses } from "../agent/activity.ts";
import { Conversation } from "../agent/Conversation.tsx";
import type { LiveWork } from "../agent/LiveWorkLine.tsx";
import { threadItems, type WorkStep, withWork } from "../agent/thread.ts";
import type { AgentSessionView } from "../agent/useAgentSession.ts";
import type { ApiClient } from "../lib/api.ts";
import type { TimelineRow } from "../session/key-uses.ts";
import type { StepRowView } from "../session/session-view.ts";
import "./conversation.css";

const NO_ROWS: TimelineRow<StepRowView>[] = [];

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
  computerReady = false,
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
  computerReady?: boolean;
}) {
  const model = agent?.model;
  const ended = model?.ended?.reason;
  const steps = useMemo<WorkStep[]>(
    () =>
      model
        ? foldKeyUses(activityRows(rows, model))
            .filter((entry) => entry.row.kind === "step")
            .map((entry) => ({ key: entry.key, ...entryView(entry, model.changes, !!ended) }))
        : [],
    [rows, model, ended],
  );
  const items = useMemo(
    () =>
      model ? threadItems(model.messages.values(), model.questions.values(), model.results) : [],
    [model],
  );
  const working = !!live && live.phase !== "finished" && !ended;
  const thread = useMemo(() => withWork(items, steps, working), [items, steps, working]);
  return (
    <Conversation
      visible={visible}
      ownerKey={agent?.sessionId ?? ""}
      items={thread}
      truncated={model?.historyTruncated ?? false}
      live={working ? live : null}
      ended={ended}
      pendingAsk={model?.pendingAsk ?? null}
      api={api}
      sessionId={agent?.sessionId ?? null}
      recovery={recovery}
      error={agent?.error}
      onReplay={onReplay}
      computerReady={computerReady}
      composer={composer}
      answer={answer}
      cover={cover}
      covered={covered}
    />
  );
}

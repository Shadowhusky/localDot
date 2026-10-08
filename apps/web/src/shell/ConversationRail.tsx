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
}: {
  agent?: AgentSessionView;
  composer?: ReactNode;
  // Takes the composer's place while dot waits for an answer; the composer stays mounted, draft and all.
  answer?: ReactNode;
  recovery?: ReactNode;
  visible?: boolean;
  rows?: TimelineRow<StepRowView>[];
  live?: LiveWork | null;
  api?: ApiClient | null;
  onReplay?: () => void;
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
    <aside className="rail conversation-rail" aria-label="Conversation">
      <div className="rail-h">
        <h2>Conversation</h2>
      </div>
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
        dock={
          <>
            {answer}
            <div className="thread-composer" hidden={!!answer}>
              {composer}
            </div>
          </>
        }
      />
    </aside>
  );
}

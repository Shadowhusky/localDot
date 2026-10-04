import { type ReactNode, useMemo } from "react";
import { Conversation } from "../agent/Conversation.tsx";
import type { AgentSessionView } from "../agent/useAgentSession.ts";
import { MascotDock } from "./MascotDock.tsx";
export function ConversationRail({
  agent,
  composer,
  visible = true,
}: {
  agent?: AgentSessionView;
  composer?: ReactNode;
  visible?: boolean;
}) {
  const messageMap = agent?.model.messages;
  const messages = useMemo(() => (messageMap ? [...messageMap.values()] : []), [messageMap]);
  return (
    <aside className="rail conversation-rail" aria-label="Conversation">
      <div className="rail-h">
        <h2>Conversation</h2>
      </div>
      <Conversation
        visible={visible}
        ownerKey={agent?.sessionId ?? ""}
        messages={messages}
        truncated={agent?.model.historyTruncated ?? false}
      />
      {agent?.error && (
        <p className="rail-error" role="status">
          {agent.error}
        </p>
      )}
      <div className="conversation-controls">{composer ?? <MascotDock />}</div>
    </aside>
  );
}

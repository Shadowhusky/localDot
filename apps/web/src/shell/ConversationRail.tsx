import type { AgentSessionView } from "../agent/useAgentSession.ts";
import { MascotDock } from "./MascotDock.tsx";
export function ConversationRail({ agent }: { agent?: AgentSessionView }) {
  const messages = agent ? [...agent.model.messages.values()] : [];
  return (
    <aside className="rail conversation-rail" aria-label="Conversation">
      <div className="rail-h">
        <h2>Conversation</h2>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus and scroll the bounded transcript. */}
      <section className="msgs" tabIndex={0} aria-label="Conversation history">
        {messages.length ? (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <p className="message-who">
                {message.role === "user" ? "You" : "dot"}
                {!message.final && <span> · writing</span>}
              </p>
              <p className="say message-text">{message.text}</p>
              {message.truncated && <p className="history-note">Message preview shortened.</p>}
            </article>
          ))
        ) : (
          <div className="conversation-empty">
            <h3>What would you like done?</h3>
            <p>Your conversation with dot appears here once the first task starts.</p>
            <p className="history-note">Start your computer to begin.</p>
          </div>
        )}
        {agent?.model.historyTruncated && (
          <p className="history-note">
            Showing recent activity. Earlier history is kept in the task log.
          </p>
        )}
      </section>
      {agent?.error && (
        <p className="rail-error" role="status">
          {agent.error}
        </p>
      )}
      <MascotDock />
    </aside>
  );
}

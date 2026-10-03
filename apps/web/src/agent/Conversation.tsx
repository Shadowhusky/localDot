import { keyLikePresent } from "@localdot/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentMessage } from "./model.ts";
import { SafeMarkdown } from "./SafeMarkdown.tsx";

export function Conversation({
  messages,
  truncated,
  visible = true,
}: {
  messages: readonly AgentMessage[];
  truncated: boolean;
  visible?: boolean;
}) {
  const view = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const shown = useRef(visible);
  const previousMessages = useRef<readonly AgentMessage[] | null>(null);
  const [unread, setUnread] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  useLayoutEffect(() => {
    const changed = previousMessages.current !== messages;
    previousMessages.current = messages;
    shown.current = visible;
    const element = view.current;
    if (!element) return;
    if (!visible) {
      if (changed) setUnread(true);
      return;
    }
    if (atBottom.current) {
      element.scrollTop = element.scrollHeight;
      setUnread(false);
    } else if (changed) setUnread(true);
  }, [messages, visible]);
  useEffect(() => {
    const element = view.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (shown.current && atBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <section
        className="msgs"
        ref={view}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users focus and scroll the bounded transcript.
        tabIndex={0}
        aria-label="Conversation history"
        onScroll={(event) => {
          if (!visible) return;
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop < 32;
          if (atBottom.current) setUnread(false);
        }}
      >
        {messages.length ? (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <p className="message-who">
                {message.role === "user" ? "You" : "dot"}
                {!message.final && <span> · writing</span>}
              </p>
              {message.role === "assistant" ? (
                <SafeMarkdown text={message.text} />
              ) : (
                <p className="say message-text">{message.text}</p>
              )}
              {message.truncated && <p className="history-note">Message preview shortened.</p>}
              <button
                type="button"
                className="copy-message"
                disabled={keyLikePresent(message.text)}
                aria-label={`Copy ${message.role === "user" ? "your" : "dot's"} message`}
                onClick={() => {
                  if (keyLikePresent(message.text)) return;
                  const write = navigator.clipboard?.writeText;
                  if (!write) {
                    setCopyStatus("Copy is unavailable in this browser.");
                    return;
                  }
                  void navigator.clipboard.writeText(message.text).then(
                    () => setCopyStatus("Message copied."),
                    () => setCopyStatus("Could not copy the message."),
                  );
                }}
              >
                Copy
              </button>
            </article>
          ))
        ) : (
          <div className="conversation-empty">
            <h3>What would you like done?</h3>
            <p>Start your computer, then write a task below.</p>
          </div>
        )}
        {truncated && (
          <p className="history-note">
            Showing recent activity. Earlier history is kept in the task log.
          </p>
        )}
      </section>
      {unread && (
        <button
          type="button"
          className="new-messages"
          onClick={() => {
            if (view.current) view.current.scrollTop = view.current.scrollHeight;
            atBottom.current = true;
            setUnread(false);
          }}
        >
          New messages
        </button>
      )}
      {copyStatus && (
        <p className="history-note" role="status">
          {copyStatus}
        </p>
      )}
    </>
  );
}

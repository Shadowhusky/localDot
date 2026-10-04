import { keyLikePresent } from "@localdot/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistoryPages } from "./HistoryPages.tsx";
import type { AgentMessage } from "./model.ts";
import { SafeMarkdown } from "./SafeMarkdown.tsx";
import { usePagedRows } from "./usePagedRows.ts";

const messageKey = (message: AgentMessage) => message.id;

export function Conversation({
  messages,
  truncated,
  visible = true,
  ownerKey = "",
}: {
  messages: readonly AgentMessage[];
  truncated: boolean;
  visible?: boolean;
  ownerKey?: string;
}) {
  const page = usePagedRows(messages, messageKey, ownerKey);
  const view = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const shown = useRef(visible);
  const previousMessages = useRef<readonly AgentMessage[] | null>(null);
  const previousPage = useRef<string | undefined>(undefined);
  const firstVisibleId = page.rows[0]?.id;
  const [unread, setUnread] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState({ owner: ownerKey, text: "" });
  const announced = useRef({ owner: ownerKey, id: "" });
  const completed = messages.findLast((message) => message.role === "assistant" && message.final);
  useEffect(() => {
    if (!visible || !completed) return;
    if (announced.current.owner === ownerKey && announced.current.id === completed.id) return;
    announced.current = { owner: ownerKey, id: completed.id };
    setAnnouncement({
      owner: ownerKey,
      text: keyLikePresent(completed.text)
        ? "dot replied."
        : `dot replied: ${completed.text.slice(0, 200)}`,
    });
  }, [completed, ownerKey, visible]);
  useLayoutEffect(() => {
    const changed = previousMessages.current !== messages;
    const pageChanged = previousPage.current !== firstVisibleId;
    previousPage.current = firstVisibleId;
    previousMessages.current = messages;
    shown.current = visible;
    const element = view.current;
    if (!element) return;
    if (!visible) {
      if (changed || pageChanged) setUnread(true);
      return;
    }
    if (atBottom.current) {
      element.scrollTop = element.scrollHeight;
      setUnread(false);
    } else if (changed) setUnread(true);
  }, [messages, visible, firstVisibleId]);
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
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {visible && announcement.owner === ownerKey ? announcement.text : ""}
      </span>
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
          else page.freeze();
        }}
      >
        {messages.length ? (
          page.rows.map((message) => (
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
        <HistoryPages
          label="messages"
          older={page.hasOlder}
          newer={page.hasNewer}
          onOlder={() => {
            atBottom.current = false;
            page.older();
            if (view.current) view.current.scrollTop = 0;
          }}
          onNewer={() => {
            atBottom.current = false;
            page.newer();
            if (view.current) view.current.scrollTop = 0;
          }}
        />
        {page.retained && (
          <p className="history-note">
            This page is retained for reading while the live preview advances.
          </p>
        )}
        {truncated && (
          <p className="history-note">
            Showing recent activity. Earlier history is kept in the task log.
          </p>
        )}
      </section>
      {(unread || !page.following) && (
        <button
          type="button"
          className="new-messages"
          onClick={() => {
            if (view.current) view.current.scrollTop = view.current.scrollHeight;
            atBottom.current = true;
            page.latest();
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

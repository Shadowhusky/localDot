import { type CSSProperties, useEffect, useId, useMemo, useRef, useState } from "react";
import { count } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";
import { useSessionNow } from "../session/useNowMs.ts";
import { Button } from "../ui/Button.tsx";
import { useVirtualRows } from "../ui/useVirtualRows.ts";
import { ControlFailure, changeResearch } from "./control-api.ts";
import type { AgentResearch } from "./model.ts";
import { researchMeta, researchUsed, STOP_WORDS, sourceMeta, sourceSite } from "./research.ts";

// The newest sources show while dot reads; the rest are one tap away.
const SHOWN = 5;
const estimateSource = () => 52;

export interface ResearchSourcesProps {
  research: AgentResearch;
  // The session's now, for the minutes used; without it they count by themselves while dot works.
  nowMs?: number;
  // dot is still working: the user can wrap up or keep going.
  working: boolean;
  api: ApiClient;
  sessionId: string;
}

const linkable = (url: string) => /^https?:\/\//i.test(url);

// Research mode's live source list in Activity: how far through its budget dot is, every page it
// read by its number (each opens the page), and the user's word on when to stop.
export function ResearchSources({
  research,
  nowMs,
  working,
  api,
  sessionId,
}: ResearchSourcesProps) {
  const id = useId();
  const counted = useSessionNow(nowMs === undefined && working, research.startMs);
  const at = nowMs ?? counted ?? undefined;
  const [all, setAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const sources = research.sources;
  const shown = all || sources.length <= SHOWN + 1 ? sources : sources.slice(-SHOWN);
  const list = useRef<HTMLOListElement>(null);
  const keys = useMemo(() => shown.map((source) => String(source.n)), [shown]);
  const windowed = useVirtualRows(list, keys, estimateSource);
  const change = (next: "wrap_up" | "more") => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setSending(true);
    setProblem(null);
    changeResearch(api, sessionId, next, abort.signal)
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setProblem(
          error instanceof ControlFailure && error.status === 409
            ? "dot has finished reading."
            : "That didn't reach dot. Try again.",
        );
      })
      .finally(() => {
        if (request.current === abort) setSending(false);
      });
  };
  const note =
    problem ??
    (research.stopped
      ? STOP_WORDS[research.stopped]
      : `dot stops reading at ${research.budget.sources} sources or ${count(research.budget.minutes, "minute", "minutes")}.`);
  return (
    <section className="activity-section research" aria-labelledby={`${id}-head`}>
      <div className="activity-section-head">
        <h3 id={`${id}-head`} className="ui-visually-hidden">
          Sources
        </h3>
        <span className="activity-section-meta num">{researchMeta(research, at)}</span>
      </div>
      <div
        className="research-track"
        aria-hidden="true"
        style={{ "--_used": researchUsed(research, at) } as CSSProperties}
      />
      {sources.length ? (
        <ol ref={list} className="research-sources" aria-label="Sources dot read">
          <li aria-hidden="true" style={{ height: windowed.before }} />
          {windowed.indexes.map((index) => {
            const source = shown[index];
            if (!source) return null;
            const body = (
              <>
                <span className="research-number num">{source.n}</span>
                <span className="research-text">
                  <span className="research-title">{source.title || sourceSite(source.url)}</span>
                  <span className="research-meta">{sourceMeta(source)}</span>
                </span>
              </>
            );
            return (
              <li
                ref={windowed.measure}
                data-index={index}
                key={source.n}
                className="research-source"
                data-cited={source.cited || undefined}
              >
                {linkable(source.url) ? (
                  <a
                    className="research-row"
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={source.url}
                  >
                    {body}
                  </a>
                ) : (
                  <span className="research-row">{body}</span>
                )}
              </li>
            );
          })}
          <li aria-hidden="true" style={{ height: windowed.after }} />
        </ol>
      ) : (
        <p className="activity-empty">Sources appear here as dot reads them.</p>
      )}
      {sources.length > SHOWN + 1 && (
        <Button
          variant="quiet"
          size="sm"
          className="research-all"
          aria-expanded={all}
          onClick={() => setAll((open) => !open)}
        >
          {all ? "Show fewer" : `Show all ${sources.length}`}
        </Button>
      )}
      {working && (
        <div className="research-foot">
          <p className="research-note" role={problem ? "alert" : undefined}>
            {note}
          </p>
          {research.stopped ? (
            <Button variant="secondary" size="sm" busy={sending} onClick={() => change("more")}>
              Keep going
            </Button>
          ) : (
            <Button variant="quiet" size="sm" busy={sending} onClick={() => change("wrap_up")}>
              Wrap up now
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

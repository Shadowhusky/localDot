import {
  type ApprovalAnswer,
  type ApprovalCard,
  ApprovalCard as CardSchema,
} from "@localdot/protocol";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { ApprovalValue } from "../agent/ApprovalValue.tsx";
import { type DecisionScope, decisionWords, defaultScope, ONCE } from "../copy/decision.ts";
import { clock } from "../copy/format.ts";
import { Button } from "../ui/Button.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { isApple } from "../ui/Kbd.tsx";
import { matches, REDUCED_MOTION } from "../ui/media.ts";
import { Presence } from "../ui/Presence.tsx";
import { Select } from "../ui/Select.tsx";
import { attachSheetDrag } from "../ui/sheet-drag.ts";
import "./decision.css";
import { useKeyboardInset } from "./layout.ts";

class Mismatch extends Error {}

export interface ApprovalDecisionProps {
  card: ApprovalCard;
  onDecision(value: ApprovalAnswer): Promise<boolean> | boolean | undefined;
  pending: boolean;
  enabled?: boolean;
  loadField?(approvalId: string, field: number, signal: AbortSignal): Promise<string>;
  // In the island over the stage, or in a phone's sheet.
  layout?: "island" | "sheet";
}

// The approval the island grows into (design-v2 §10.16): the question in the action's own verb,
// every value whole with its hidden characters shown, why it asks, and how far a yes reaches.
export function ApprovalDecision({
  card,
  onDecision,
  pending,
  enabled = true,
  loadField,
  layout = "island",
}: ApprovalDecisionProps) {
  const value = CardSchema.safeParse(card);
  const heading = useRef<HTMLHeadingElement>(null);
  const offeredFocus = useRef(false);
  const [now, setNow] = useState(Date.now());
  const [whole, setWhole] = useState<ReadonlyMap<number, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<DecisionScope>(() => defaultScope(card));
  const [chosen, setChosen] = useState<ApprovalAnswer["decision"] | null>(null);
  const loader = useRef<AbortController | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(timer);
      loader.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!enabled || offeredFocus.current) return;
    offeredFocus.current = true;
    // This non-modal prompt arrives in the background. Keep the user's current control and
    // caret, and never take focus again just because the task reconnects.
    const active = document.activeElement;
    if (!document.hidden && (!active || active === document.body))
      heading.current?.focus({ preventScroll: true });
  }, [enabled]);
  const partial = new Map(value.data?.partial?.map(({ field, length }) => [field, length]));
  if (
    !value.success ||
    partial.size !== (value.data.partial?.length ?? 0) ||
    [...partial].some(
      ([field, length]) => (value.data.fields[field]?.[1].length ?? length) >= length,
    )
  )
    return (
      <div className="decision" data-layout={layout}>
        <p className="decision-invalid" role="alert">
          This decision could not be verified. Check task status again.
        </p>
      </div>
    );
  const data = value.data;
  const words = decisionWords(data);
  const expired = now >= data.expiresAt;
  const unread = [...partial.keys()].some((field) => !whole.has(field));
  const canDecide = enabled && !pending && !expired;
  const canApprove = canDecide && !unread;
  const scopes = data.always?.length
    ? [
        { value: ONCE, label: "Just this once" },
        ...data.always.map((option) => ({ value: option.scope, label: option.label })),
      ]
    : [];
  const showAll = async (field: number, preview: string, length: number) => {
    if (!loadField || loading) return;
    const abort = new AbortController();
    loader.current = abort;
    setLoading(true);
    setLoadError(null);
    try {
      const text = await loadField(data.approvalId, field, abort.signal);
      if (text.length !== length || !text.startsWith(preview)) throw new Mismatch();
      if (!abort.signal.aborted) setWhole((old) => new Map(old).set(field, text));
    } catch (error) {
      if (!abort.signal.aborted)
        setLoadError(
          error instanceof Mismatch
            ? "The full text could not be checked. Deny, or take control."
            : "The full text could not be loaded. Try again, deny, or take control.",
        );
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  };
  const decide = (decision: ApprovalAnswer["decision"]) => {
    if (!enabled || pending || Date.now() >= data.expiresAt) return;
    if (decision === "approve" && unread) return;
    const always = decision === "approve" && scope !== ONCE ? scope : undefined;
    setChosen(decision);
    void onDecision({
      approvalId: data.approvalId,
      generation: data.generation,
      revision: data.revision,
      decision,
      ...(always ? { always } : {}),
    });
  };
  // Esc is the secondary and ⌘Return the primary; a plain Return sends nothing by accident.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (canDecide) decide("deny");
    } else if (event.key === "Enter" && (isApple() ? event.metaKey : event.ctrlKey)) {
      event.preventDefault();
      if (canApprove) decide("approve");
    }
  };
  // Pending, the pressed button spins and the other waits; otherwise each says why it can't act.
  const held = (decision: ApprovalAnswer["decision"]) =>
    expired
      ? "This decision has expired"
      : pending
        ? chosen === decision
          ? undefined
          : "Wait a moment"
        : enabled
          ? undefined
          : "Reconnecting to the task…";
  const sheet = layout === "sheet";
  return (
    <section
      className="decision"
      data-layout={layout}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`approval-${data.approvalId}`}
      onKeyDown={onKeyDown}
    >
      <div className="decision-body">
        <h2
          ref={heading}
          tabIndex={-1}
          id={`approval-${data.approvalId}`}
          className="decision-title"
        >
          {words.title}
        </h2>
        {data.fields.length > 0 && (
          <dl className="decision-facts">
            {data.fields.map(([label, text], index) => {
              const length = whole.has(index) ? undefined : partial.get(index);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: these are immutable text rows within one approval identity, with no field state.
                <div key={index} className="decision-fact">
                  <dt>{label}</dt>
                  <dd>
                    {/* A fresh mount for the whole text: updating thousands of parts in place is quadratic in React. */}
                    <ApprovalValue
                      key={whole.has(index) ? "whole" : "start"}
                      label={label}
                      text={whole.get(index) ?? text}
                      total={length}
                      focusOnMount={whole.has(index)}
                    />
                    {length !== undefined && loadField && (
                      <Button
                        variant="quiet"
                        size="sm"
                        className="decision-show-all"
                        aria-label={`Show all of ${label}`}
                        busy={loading}
                        disabledReason={expired ? "This decision has expired" : undefined}
                        onClick={() => void showAll(index, text, length)}
                      >
                        Show all
                      </Button>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
        {data.upload && <UploadFacts upload={data.upload} />}
        {loadError && (
          <p className="decision-warning" role="alert">
            {loadError}
          </p>
        )}
        <p className="decision-why">
          <Icon name="info" size={16} />
          <span>{words.why}</span>
        </p>
      </div>
      <div className="decision-foot">
        {scopes.length > 0 ? (
          <Select
            appearance="inline"
            size="sm"
            className="decision-scope"
            aria-label="How long this answer lasts"
            value={scope}
            items={scopes}
            onValueChange={(next) => setScope(next as DecisionScope)}
          />
        ) : (
          !sheet && <span className="decision-scope-gap" />
        )}
        <div className="decision-actions">
          <Button
            size={sheet ? "xxl" : "md"}
            disabledReason={held("deny")}
            busy={pending && chosen === "deny"}
            onClick={() => decide("deny")}
          >
            {words.secondary}
          </Button>
          <Button
            variant={data.actionClass === "delete" ? "destructive" : "primary"}
            size={sheet ? "xxl" : "md"}
            disabledReason={
              held("approve") ?? (unread ? "Show all of the text before you approve." : undefined)
            }
            busy={pending && chosen === "approve"}
            onClick={() => decide("approve")}
          >
            {words.primary}
          </Button>
        </div>
      </div>
    </section>
  );
}

function UploadFacts({ upload }: { upload: NonNullable<ApprovalCard["upload"]> }) {
  const count = upload.files.length;
  return (
    <section className="decision-upload" aria-label="Files to upload">
      <p className="decision-upload-to">
        <span>
          Page receiving files
          {upload.destination.embedded ? " · embedded frame" : ""}
        </span>
        <strong>
          <bdi>{upload.destination.origin}</bdi>
        </strong>
      </p>
      <p className="decision-upload-note">
        This page will be able to read these files and may send them elsewhere.
      </p>
      <h3>
        {count} file{count === 1 ? "" : "s"} to upload
      </h3>
      <ul className="decision-files">
        {upload.files.map((file) => (
          <li key={file.path}>
            <div className="decision-file-head">
              <strong>
                <bdi>{file.name}</bdi>
              </strong>
              <span className="num">{file.bytes.toLocaleString()} bytes</span>
            </div>
            <p className="decision-file-path">
              <bdi>{file.path}</bdi>
            </p>
            <Disclosure summary="File checksum">
              <p className="decision-file-digest">SHA-256: {file.sha256}</p>
            </Disclosure>
          </li>
        ))}
      </ul>
    </section>
  );
}

// A phone's decision can grow over the stage; its full form scrolls above the keyboard.
interface DecisionSheetProps {
  label: string;
  elapsedS: number | null;
  children: ReactNode;
}

// A phone's decision rises from the bottom edge and, once answered, sinks back the way it came,
// still showing what it asked until it has gone.
export function DecisionSheetPresence({ show, ...sheet }: DecisionSheetProps & { show: boolean }) {
  const kept = useRef(sheet);
  if (show) kept.current = sheet;
  return (
    <Presence show={show}>
      <div className="decision-sheet-hold">
        <DecisionSheet {...kept.current} />
      </div>
    </Presence>
  );
}

export function DecisionSheet({ label, elapsedS, children }: DecisionSheetProps) {
  const keyboard = useKeyboardInset();
  // Read as a drag lets go: the keyboard coming or going never drops a drag under way.
  const typing = useRef(keyboard);
  typing.current = keyboard;
  const panel = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const full = expanded || keyboard > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing detent by button must interrupt an in-flight drag spring.
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const height = () => Number.parseFloat(getComputedStyle(element).maxHeight);
    return attachSheetDrag({
      panel: element,
      scrim: null,
      stops: () => (typing.current ? [0] : [0, height() * 0.45]),
      rest: (index) => flushSync(() => setExpanded(index === 0)),
      // A swipe must never dismiss or answer an outstanding question.
      allowDismiss: () => false,
      close: () => {},
      reducedMotion: () => matches(REDUCED_MOTION),
      presentation: {
        read: () => height() - element.getBoundingClientRect().height,
        apply: (offset) => {
          element.style.height = `${Math.max(120, height() - offset)}px`;
        },
        clear: () => element.style.removeProperty("height"),
      },
    });
  }, [expanded]);
  return (
    <div
      ref={panel}
      className="decision-sheet"
      data-expanded={full ? "" : undefined}
      data-keyboard={keyboard ? "" : undefined}
      style={keyboard ? ({ "--_keyboard": `${keyboard}px` } as CSSProperties) : undefined}
    >
      <div className="decision-sheet-handle" data-sheet-grip="">
        <span className="decision-grabber" aria-hidden="true" />
      </div>
      <div className="decision-sheet-head" data-sheet-grip="">
        <span className="decision-attention" aria-hidden="true" />
        <span>{label}</span>
        <span className="decision-sheet-elapsed num">
          {elapsedS === null ? "" : clock(elapsedS)}
        </span>
      </div>
      <IconButton
        className="decision-sheet-expand"
        label={full ? "Collapse question" : "Expand question"}
        icon={full ? "chevron-down" : "chevron-up"}
        size={32}
        aria-expanded={full}
        onClick={() => setExpanded(!full)}
        disabledReason={keyboard > 0 ? "Expanded while typing" : undefined}
      />
      <div className="decision-sheet-content">{children}</div>
    </div>
  );
}

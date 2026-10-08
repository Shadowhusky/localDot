import {
  type ApprovalAnswer,
  type ApprovalCard as Card,
  ApprovalCard as CardSchema,
} from "@localdot/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApprovalValue } from "./ApprovalValue.tsx";

class Mismatch extends Error {}
export function ApprovalCard({
  card,
  onDecision,
  pending,
  enabled = true,
  visible = true,
  loadField,
  children,
}: {
  card: Card;
  onDecision(value: ApprovalAnswer): Promise<boolean> | boolean | undefined;
  pending: boolean;
  enabled?: boolean;
  visible?: boolean;
  loadField?(approvalId: string, field: number, signal: AbortSignal): Promise<string>;
  children?: ReactNode | ((canApprove: boolean) => ReactNode);
}) {
  const value = CardSchema.safeParse(card);
  const heading = useRef<HTMLHeadingElement>(null);
  const [now, setNow] = useState(Date.now());
  const [whole, setWhole] = useState<ReadonlyMap<number, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
    if (visible && enabled && !document.hidden) heading.current?.focus({ preventScroll: true });
  }, [enabled, visible]);
  const partial = new Map(value.data?.partial?.map(({ field, length }) => [field, length]));
  if (
    !value.success ||
    partial.size !== (value.data.partial?.length ?? 0) ||
    [...partial].some(
      ([field, length]) => (value.data.fields[field]?.[1].length ?? length) >= length,
    )
  )
    return <p role="alert">This decision could not be verified. Check task status again.</p>;
  const expired = now >= value.data.expiresAt;
  const unread = [...partial.keys()].some((field) => !whole.has(field));
  const canApprove = visible && enabled && !pending && !expired && !unread;
  const showAll = async (field: number, preview: string, length: number) => {
    if (!loadField || loading) return;
    const abort = new AbortController();
    loader.current = abort;
    setLoading(true);
    setLoadError(null);
    try {
      const text = await loadField(value.data.approvalId, field, abort.signal);
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
    if (!visible || !enabled || pending || Date.now() >= value.data.expiresAt) return;
    void onDecision({
      approvalId: value.data.approvalId,
      generation: value.data.generation,
      revision: value.data.revision,
      decision,
    });
  };
  return createPortal(
    <div className="approval-overlay" hidden={!visible}>
      <section
        className="approval-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby={`approval-${value.data.approvalId}`}
      >
        <div className="approval-content">
          <p className="safety-eyebrow">Your decision · {value.data.risk} impact</p>
          <h2 ref={heading} tabIndex={-1} id={`approval-${value.data.approvalId}`}>
            {value.data.title}
          </h2>
          <dl>
            {value.data.fields.map(([label, text], index) => {
              const length = whole.has(index) ? undefined : partial.get(index);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: these are immutable text rows within one approval identity, with no field state.
                <div key={index}>
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
                      <button
                        type="button"
                        className="approval-show-all"
                        aria-label={`Show all of ${label}`}
                        disabled={!visible || expired || loading}
                        onClick={() => void showAll(index, text, length)}
                      >
                        Show all
                      </button>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          {loadError && (
            <p className="approval-value-warning" role="alert">
              {loadError}
            </p>
          )}
          {value.data.upload && (
            <section className="approval-upload" aria-label="Files to upload">
              <p className="approval-upload-destination">
                <span>
                  Page receiving files
                  {value.data.upload.destination.embedded ? " · embedded frame" : ""}
                </span>
                <strong>
                  <bdi>{value.data.upload.destination.origin}</bdi>
                </strong>
              </p>
              <p className="approval-upload-note">
                This page will be able to read these files and may send them elsewhere.
              </p>
              <h3>
                {value.data.upload.files.length} file
                {value.data.upload.files.length === 1 ? "" : "s"} to upload
              </h3>
              <ul className="approval-upload-files">
                {value.data.upload.files.map((file) => (
                  <li key={file.path}>
                    <div className="approval-upload-file-heading">
                      <strong>
                        <bdi>{file.name}</bdi>
                      </strong>
                      <span>{file.bytes.toLocaleString()} bytes</span>
                    </div>
                    <p className="approval-upload-path">
                      <bdi>{file.path}</bdi>
                    </p>
                    <details>
                      <summary>File checksum</summary>
                      <p className="approval-upload-digest">SHA-256: {file.sha256}</p>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {typeof children === "function" ? children(canApprove) : children}
        </div>
        <div className="approval-footer">
          <p role="status">
            {expired
              ? "This decision has expired. Check task status for the current request."
              : pending
                ? "Checking your decision with the computer…"
                : unread
                  ? "Show all of the text before you approve."
                  : "Approve this action once, decline it, or take control yourself."}
          </p>
          <div className="safety-actions">
            <button type="button" disabled={!canApprove} onClick={() => decide("approve")}>
              Approve once
            </button>
            <button
              type="button"
              disabled={!visible || !enabled || pending || expired}
              onClick={() => decide("deny")}
            >
              Deny
            </button>
            <button
              type="button"
              disabled={!visible || !enabled || pending || expired}
              onClick={() => decide("take_control")}
            >
              Take control
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

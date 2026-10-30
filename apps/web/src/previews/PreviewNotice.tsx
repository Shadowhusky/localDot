import { useRef } from "react";
import { Button } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
import { type PreviewNoticeState, type Previews, unavailable } from "./PreviewsContext.tsx";
import "../ui/previews.css";

const TITLES = {
  "needs-tailscale": "Previews open over Tailscale",
  "needs-update": "Update your computer to open previews",
  "computer-off": "Your computer is off",
  ready: "Couldn't open the preview",
} as const;

// Beside the chip or button that was tapped: why the preview didn't open, and the step that fixes it.
export function PreviewNotice({ previews }: { previews: Previews | null }) {
  const notice = previews?.notice ?? null;
  // A closing popover keeps showing what it said.
  const last = useRef<PreviewNoticeState | null>(null);
  if (notice) last.current = notice;
  const shown = notice ?? last.current;
  const anchor = useRef<HTMLElement | null>(null);
  anchor.current = shown?.anchor ?? null;
  if (!previews || !shown) return null;
  const close = previews.closeNotice;
  const state = shown.refusal?.state;
  const update = previews.update;
  const settings = (
    <Button
      size="sm"
      variant="primary"
      onClick={() => {
        close();
        previews.openSettings(shown.anchor);
      }}
    >
      Open settings
    </Button>
  );
  return (
    <Popover
      open={!!notice}
      onClose={close}
      anchor={anchor}
      title={
        shown.copy && shown.link
          ? "Copy the link"
          : shown.link
            ? "Your preview is ready"
            : TITLES[state ?? "ready"]
      }
      className="preview-notice"
    >
      <p className="preview-notice-text">
        {shown.copy && shown.link
          ? "Your browser didn't let localDot copy it. Select it to copy it yourself: it opens the app once, within two minutes."
          : shown.link
            ? "Your browser kept it from opening a new tab."
            : state
              ? unavailable(state, shown.refusal?.message).message
              : shown.refusal?.message}
      </p>
      {shown.copy && shown.link && <p className="preview-notice-url">{shown.link}</p>}
      <div className="preview-notice-actions">
        {shown.link && !shown.copy && (
          <a
            className="preview-notice-link"
            href={shown.link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={close}
          >
            Open preview
          </a>
        )}
        {state === "needs-tailscale" && settings}
        {state === "needs-update" &&
          (update?.available ? (
            <Button
              size="sm"
              variant="primary"
              busy={update.busy}
              disabledReason={update.waitReason}
              onClick={() => {
                update.run();
                close();
              }}
            >
              Update
            </Button>
          ) : (
            settings
          ))}
        {!state && shown.request && (
          <Button
            size="sm"
            onClick={() => {
              if (!shown.request) return;
              if (shown.copy) previews.copy(shown.request, shown.anchor);
              else previews.open(shown.request, shown.anchor);
            }}
          >
            Try again
          </Button>
        )}
      </div>
    </Popover>
  );
}

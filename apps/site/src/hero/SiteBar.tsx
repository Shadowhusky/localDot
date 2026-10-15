import "@app/shell/bar.css";
import { SegmentedControl } from "@app/ui/SegmentedControl.tsx";
import { t } from "../i18n.ts";

export type BarMode = "watch" | "replay";

// The app's top bar in the demo's window: its wordmark, the replayed task's title marked as a
// replay, and Watch and Replay. The website's own bar above the window has the rest.
export function SiteBar({
  title,
  mode,
  onMode,
}: {
  title?: string;
  mode: BarMode;
  onMode(mode: BarMode): void;
}) {
  return (
    <header className="bar site-bar">
      <div className="bar-l">
        <span className="bar-wordmark site-bar-wordmark">localDot</span>
        {title && (
          <>
            <span className="bar-sep" aria-hidden="true" />
            <span key={title} className="bar-title">
              {title}
            </span>
            <span className="site-replay-badge">{t("Replay")}</span>
          </>
        )}
      </div>
      <div className="bar-r">
        <SegmentedControl
          className="bar-modes"
          aria-label={t("Mode")}
          size={28}
          items={[
            { value: "watch", label: t("Watch") },
            { value: "replay", label: t("Replay") },
          ]}
          value={mode}
          onValueChange={(value) => onMode(value as BarMode)}
        />
      </div>
    </header>
  );
}

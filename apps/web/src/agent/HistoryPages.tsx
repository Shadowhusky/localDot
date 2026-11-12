import { t } from "../i18n/index.ts";
import { Button } from "../ui/Button.tsx";

// The thread pages through history as it scrolls. Show earlier messages waits at the top while
// there are any; Newer is the keyboard and screen-reader way back down, out of sight until focused.
export function HistoryPages({
  older,
  newer,
  onOlder,
  onNewer,
}: {
  older: boolean;
  newer: boolean;
  onOlder(): void;
  onNewer(): void;
}) {
  if (!older && !newer) return null;
  return (
    <nav className="history-pages" aria-label={t`Message pages`} data-older={older || undefined}>
      <Button
        variant="quiet"
        size="sm"
        className="history-older"
        disabledReason={older ? undefined : t`These are the earliest messages.`}
        onClick={onOlder}
      >
        {t`Show earlier messages`}
      </Button>
      <Button
        variant="quiet"
        size="sm"
        className="history-newer"
        disabledReason={newer ? undefined : t`These are the latest messages.`}
        onClick={onNewer}
      >
        {t`Newer messages`}
      </Button>
    </nav>
  );
}

import { Button } from "../ui/Button.tsx";

// The thread pages through history as it scrolls; these buttons are the keyboard and screen-reader
// way, out of sight until one has focus.
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
    <nav className="history-pages" aria-label="Message pages">
      <Button
        variant="quiet"
        size="sm"
        disabledReason={older ? undefined : "These are the earliest messages."}
        onClick={onOlder}
      >
        Older messages
      </Button>
      <Button
        variant="quiet"
        size="sm"
        disabledReason={newer ? undefined : "These are the latest messages."}
        onClick={onNewer}
      >
        Newer messages
      </Button>
    </nav>
  );
}

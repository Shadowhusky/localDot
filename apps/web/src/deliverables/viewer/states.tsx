import { createContext, type ReactNode, useContext } from "react";
import { t } from "../../i18n/index.ts";
import { FileCard } from "../../ui/Card.tsx";
import { Progress } from "../../ui/Progress.tsx";
import { SegmentedControl } from "../../ui/SegmentedControl.tsx";
import { kindLabel } from "../kind-label.ts";
import type { ViewChoice, ViewName } from "./views.ts";

// What the viewer knows of the file on show, for whichever view has to stop and say so.
export const ViewerFile = createContext<{ meta?: string; actions?: ReactNode }>({});

// While a file loads: the shape of what is coming, no words that flash past. A wait long enough to
// wonder about says what it is waiting for.
export function ViewerLoading({ label, note }: { label: string; note?: string }) {
  return (
    <div className="viewer-center" aria-busy="true">
      <Progress label={label} className="viewer-progress" />
      {note && <p className="viewer-loading-note">{note}</p>}
    </div>
  );
}

// A stop in the stage: the file's card, with what went wrong if something did, and the viewer's
// actions for it.
export function ViewerMessage({
  name,
  title,
  children,
  retry,
}: {
  name: string;
  title?: string;
  children?: ReactNode;
  retry?(): void;
}) {
  const file = useContext(ViewerFile);
  return (
    <div className="viewer-center">
      <FileCard
        name={name}
        meta={file.meta ?? kindLabel(name)}
        problem={title}
        detail={children}
        onRetry={retry}
        actions={file.actions}
      />
    </div>
  );
}

// A row of controls above the file: what it can do at the start, more controls or a quiet fact
// about it at the end; nothing when it has none.
export function ViewerBar({
  children,
  note,
  end,
}: {
  children?: ReactNode;
  note?: ReactNode;
  end?: ReactNode;
}) {
  if (!children && !note && !end) return null;
  return (
    <div className="viewer-bar">
      <div className="viewer-bar-controls">{children}</div>
      {end && <div className="viewer-bar-controls viewer-bar-end">{end}</div>}
      {note && <div className="viewer-bar-note">{note}</div>}
    </div>
  );
}

// The ways the file can be shown, at the start of its bar; nothing when there is only one.
export function ViewSwitch({ choice, without }: { choice?: ViewChoice; without?: ViewName }) {
  const items = choice?.items.filter((item) => item.value !== without) ?? [];
  if (!choice || items.length < 2) return null;
  return (
    <SegmentedControl
      size={28}
      aria-label={t`Show`}
      value={choice.value}
      items={items}
      onValueChange={choice.choose}
    />
  );
}

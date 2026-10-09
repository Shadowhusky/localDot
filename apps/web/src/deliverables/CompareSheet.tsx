import type { CompareReply, FileVersion } from "@localdot/protocol";
import { useEffect, useState } from "react";
import { DiffViewer } from "../agent/DiffViewer.tsx";
import type { ApiClient } from "../lib/api.ts";
import { Progress } from "../ui/Progress.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { loadCompare } from "./api.ts";

// The sheet's title names the file, so the patch's own file lines are left out.
export function changesOnly(patch: string): string {
  return patch.replace(/^--- [^\n]*\n\+\+\+ [^\n]*\n/, "").replace(/\n$/, "");
}

// What changed between two versions of a text file, beside the page on a wide screen and as a
// bottom sheet on a phone.
export function CompareSheet({
  api,
  sessionId,
  name,
  from,
  to,
  open,
  onClose,
}: {
  api: ApiClient;
  sessionId: string;
  name: string;
  from: FileVersion;
  to: FileVersion;
  open: boolean;
  onClose(): void;
}) {
  const [state, setState] = useState<{ reply?: CompareReply; failed?: boolean }>({});
  useEffect(() => {
    const controller = new AbortController();
    loadCompare(
      api,
      sessionId,
      name,
      { sessionId: from.sessionId, version: from.version as number },
      { sessionId: to.sessionId, version: to.version as number },
      controller.signal,
    ).then(
      (reply) => {
        if (!controller.signal.aborted) setState({ reply });
      },
      () => {
        if (!controller.signal.aborted) setState({ failed: true });
      },
    );
    return () => controller.abort();
  }, [api, sessionId, name, from, to]);
  const reply = state.reply;
  return (
    <Sheet open={open} onClose={onClose} title={`Compare ${name}`} className="compare-sheet">
      {state.failed ? (
        <p className="compare-note">Couldn't compare these versions.</p>
      ) : !reply ? (
        <Progress label="Comparing" className="compare-progress" />
      ) : reply.patch === "" ? (
        <p className="compare-note">
          No changes between v{from.label} and v{to.label}.
        </p>
      ) : (
        <div className="compare-body">
          {reply.truncated && (
            <p className="compare-note">Showing the first part of the changes.</p>
          )}
          <DiffViewer
            change={{
              id: `compare-${from.label}-${to.label}`,
              type: "file",
              path: `v${from.label} → v${to.label}`,
              op: "modify",
              patch: changesOnly(reply.patch),
              truncated: reply.truncated,
            }}
          />
        </div>
      )}
    </Sheet>
  );
}

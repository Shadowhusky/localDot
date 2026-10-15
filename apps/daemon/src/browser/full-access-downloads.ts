import type {
  QuarantineItem,
  QuarantineRelease,
} from "../../../../packages/protocol/src/quarantine.ts";

export interface FullAccessDownloadsDeps {
  session(parentCellId: string):
    | {
        readonly id: string;
        readonly stopped: boolean;
        readonly abort: AbortController;
        permissionMode(): "custom" | "auto" | "full";
      }
    | undefined;
  release(
    parentCellId: string,
    id: string,
    request: QuarantineRelease,
    signal: AbortSignal,
  ): Promise<unknown>;
}

// In Full access the running task's finished downloads reach the computer without a Review,
// through the same checks as the user's own release. Any that fails stays held for Review.
export async function releaseForFullAccess(
  deps: FullAccessDownloadsDeps,
  parentCellId: string,
  items: readonly QuarantineItem[],
): Promise<void> {
  for (const item of items) {
    const session = deps.session(parentCellId);
    if (!session || session.stopped || session.permissionMode() !== "full") return;
    if (item.state !== "held" || item.sessionId !== session.id) continue;
    await deps
      .release(
        parentCellId,
        item.id,
        {
          revision: item.revision,
          bytes: item.bytes,
          sha256: item.sha256,
          name: item.name,
          to: "computer",
        },
        session.abort.signal,
      )
      .catch(() => {});
  }
}

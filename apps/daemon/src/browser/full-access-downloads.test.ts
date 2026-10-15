import { randomUUID } from "node:crypto";
import { ulid } from "@localdot/protocol";
import { describe, expect, it, vi } from "vitest";
import type { QuarantineItem } from "../../../../packages/protocol/src/quarantine.ts";
import { releaseForFullAccess } from "./full-access-downloads.ts";

const parent = ulid();
const sessionId = ulid();

function item(over: Partial<QuarantineItem> = {}): QuarantineItem {
  return {
    version: 1,
    id: ulid(),
    parentCellId: parent,
    browserCellId: ulid(),
    browserInstance: randomUUID(),
    sessionId,
    name: "report.pdf",
    source: "files.example.com",
    bytes: 1024,
    sha256: "a".repeat(64),
    kind: "document",
    createdAt: 1,
    revision: 1,
    state: "held",
    ...over,
  } as QuarantineItem;
}

function setup(mode: "custom" | "auto" | "full", over: { stopped?: boolean; id?: string } = {}) {
  const abort = new AbortController();
  const session = {
    id: over.id ?? sessionId,
    stopped: over.stopped ?? false,
    abort,
    permissionMode: () => mode,
  };
  const release = vi.fn(async () => undefined);
  return { deps: { session: () => session, release }, release, abort };
}

describe("downloads in Full access", () => {
  it("sends the task's finished download to the computer as the Review button would", async () => {
    const f = setup("full");
    const held = item();
    await releaseForFullAccess(f.deps, parent, [held]);
    expect(f.release).toHaveBeenCalledWith(
      parent,
      held.id,
      { revision: 1, bytes: 1024, sha256: "a".repeat(64), name: "report.pdf", to: "computer" },
      f.abort.signal,
    );
  });

  it.each(["custom", "auto"] as const)("leaves a download for Review in %s", async (mode) => {
    const f = setup(mode);
    await releaseForFullAccess(f.deps, parent, [item()]);
    expect(f.release).not.toHaveBeenCalled();
  });

  it("leaves a download for Review once the task has stopped", async () => {
    const f = setup("full", { stopped: true });
    await releaseForFullAccess(f.deps, parent, [item()]);
    expect(f.release).not.toHaveBeenCalled();
  });

  it("leaves another task's download and anything no longer held for Review", async () => {
    const f = setup("full");
    await releaseForFullAccess(f.deps, parent, [
      item({ sessionId: ulid() }),
      item({ state: "discarded" } as Partial<QuarantineItem>),
    ]);
    expect(f.release).not.toHaveBeenCalled();
  });

  it("keeps a download held when its release fails, and still releases the next", async () => {
    const f = setup("full");
    f.release.mockRejectedValueOnce(new Error("The computer is not ready for a file release."));
    await releaseForFullAccess(f.deps, parent, [item(), item()]);
    expect(f.release).toHaveBeenCalledTimes(2);
  });
});

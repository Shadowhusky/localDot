import { describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./control.ts";
import { BrowserNavigation } from "./navigation-owner.ts";

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
  instance: "00000000-0000-4000-8000-000000000003",
};
const permit = {
  ...identity,
  revision: 1,
  requestId: "01J00000000000000000000004",
  owner: { sessionId: "01J00000000000000000000005", generation: 1 },
};
const tabId = "00000000-0000-4000-8000-000000000006";

async function fixture(grant = true) {
  const control = new BrowserControl({
    ...identity,
    clearSelections: async () => {},
    secretPages: async () => [],
    reload: async () => {},
  });
  if (grant) await control.set({ ...permit, holder: "agent" });
  const navigate = vi.fn(
    async (_tab: string, _url: string, _signal?: AbortSignal): Promise<"download" | void> => {},
  );
  const owner = new BrowserNavigation(control, { navigate });
  return { control, owner, navigate };
}

describe("admitted navigation lifetime", () => {
  it("refuses executable permit properties without invoking them", async () => {
    const { owner, navigate } = await fixture();
    const getter = vi.fn(() => identity.instance);
    const crafted = { ...permit };
    Object.defineProperty(crafted, "instance", { enumerable: true, get: getter });
    await expect(
      owner.navigate(crafted, tabId, "https://example.test/", new AbortController().signal),
    ).rejects.toThrow("refused");
    await expect(
      owner.navigate(
        new Proxy(permit, { get: getter }),
        tabId,
        "https://example.test/",
        new AbortController().signal,
      ),
    ).rejects.toThrow("refused");
    expect(getter).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("returns a private completion without echoing the destination", async () => {
    const { owner, navigate } = await fixture();
    const signal = new AbortController().signal;
    expect(
      await owner.navigate(permit, tabId, "https://example.test/private?value=canary", signal),
    ).toEqual({ done: true });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      tabId,
      "https://example.test/private?value=canary",
      expect.any(AbortSignal),
    );
    await owner.close();
  });

  it("reports a download separately from a page load", async () => {
    const { owner, navigate } = await fixture();
    navigate.mockResolvedValueOnce("download");
    expect(
      await owner.navigate(
        permit,
        tabId,
        "https://example.test/source.zip",
        new AbortController().signal,
      ),
    ).toEqual({ done: true, download: true });
    await owner.close();
  });

  it.each([
    "file:///tmp/private",
    "javascript:alert(1)",
    "data:text/html,private",
    "https://user:secret@example.test/",
    "",
  ])("refuses unsafe destination %s before effects", async (url) => {
    const { owner, navigate } = await fixture();
    await expect(owner.navigate(permit, tabId, url, new AbortController().signal)).rejects.toThrow(
      "request",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    { ...permit, revision: 2 },
    { ...permit, instance: "00000000-0000-4000-8000-000000000099" },
    { ...permit, owner: { ...permit.owner, generation: 2 } },
  ])("refuses stale authority with zero navigation effects", async (stale) => {
    const { owner, navigate } = await fixture();
    await expect(
      owner.navigate(stale, tabId, "https://example.test/", new AbortController().signal),
    ).rejects.toThrow("refused");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not act before handback, after closure, or for a pre-aborted request", async () => {
    const { owner, navigate, control } = await fixture(false);
    await expect(
      owner.navigate(permit, tabId, "https://example.test/", new AbortController().signal),
    ).rejects.toThrow("refused");
    await control.set({ ...permit, holder: "agent" });
    await expect(
      owner.navigate(permit, tabId, "https://example.test/", AbortSignal.abort()),
    ).rejects.toThrow("refused");
    await owner.close();
    await expect(
      owner.navigate(permit, tabId, "https://example.test/", new AbortController().signal),
    ).rejects.toThrow("closed");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("fences takeover immediately and waits for the dispatched operation before releasing authority", async () => {
    const { owner, navigate, control } = await fixture();
    const complete = Promise.withResolvers<void>();
    navigate.mockImplementation(() => complete.promise);
    const pending = owner.navigate(
      permit,
      tabId,
      "https://example.test/",
      new AbortController().signal,
    );
    const refused = expect(pending).rejects.toThrow("refused");
    const signal = navigate.mock.calls[0]?.[2];
    let handedBack = false;
    const handback = control
      .set({ ...identity, revision: 2, requestId: "01J00000000000000000000007", holder: "user" })
      .then(() => {
        handedBack = true;
      });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(handedBack).toBe(false);
    await expect(
      owner.navigate(permit, tabId, "https://example.test/", new AbortController().signal),
    ).rejects.toThrow("busy");
    complete.resolve();
    await refused;
    await handback;
    expect(handedBack).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("releases its lease before the runtime drain that a fatal navigation initiated", async () => {
    const { owner, navigate, control } = await fixture();
    let retirement: Promise<void> | undefined;
    navigate.mockImplementation(async () => {
      retirement = Promise.all([control.close(), owner.close()]).then(() => {});
      throw new Error("private navigation cause");
    });
    await expect(
      owner.navigate(permit, tabId, "https://example.test/", new AbortController().signal),
    ).rejects.toThrow("Browser navigation refused: refused");
    await retirement;
    expect(control.holder).toBe("user");
  });

  it("close waits for dispatch settlement and rejects a late success", async () => {
    const { owner, navigate } = await fixture();
    const complete = Promise.withResolvers<void>();
    navigate.mockImplementation(() => complete.promise);
    const pending = owner.navigate(
      permit,
      tabId,
      "https://example.test/",
      new AbortController().signal,
    );
    const refused = expect(pending).rejects.toThrow("refused");
    let closed = false;
    const closing = owner.close().then(() => {
      closed = true;
    });
    expect(navigate.mock.calls[0]?.[2]?.aborted).toBe(true);
    await Promise.resolve();
    expect(closed).toBe(false);
    complete.resolve();
    await refused;
    await closing;
    expect(closed).toBe(true);
  });

  it("releases the slot after a refusal so a healthy attempt may complete", async () => {
    const { owner, navigate } = await fixture();
    navigate.mockRejectedValueOnce(new Error("private transport detail"));
    await expect(
      owner.navigate(permit, tabId, "https://example.test/", new AbortController().signal),
    ).rejects.toThrow("refused");
    expect(
      await owner.navigate(permit, tabId, "https://example.test/", new AbortController().signal),
    ).toEqual({ done: true });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { toolHarness as createHarness } from "./testing/harness.ts";

const harnesses: ReturnType<typeof createHarness>[] = [];
function toolHarness() {
  const h = createHarness();
  harnesses.push(h);
  return h;
}
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
});

const taints = (h: ReturnType<typeof toolHarness>) =>
  h.events().flatMap((event) => (event.type === "safety.taint" ? [event.data] : []));

describe("where a task reads private data", () => {
  it("a file read or listed", async () => {
    const h = toolHarness();
    h.desktop.files.set("notes.txt", "Account 4417-1234-5678");
    await h.call("files", { op: "read", path: "notes.txt" });
    await h.call("files", { op: "list", path: "Documents" });
    expect(taints(h)).toEqual([
      { kind: "files", origin: "~/notes.txt" },
      { kind: "files", origin: "~/Documents" },
    ]);
    expect(h.session.taint.overlap("my account 4417-1234-5678").overlaps).toBe(true);
  });

  it("a page read on a screen the user is signed in on, and not on another", async () => {
    const h = toolHarness();
    await h.call("browser_read", {});
    expect(taints(h)).toEqual([]);
    h.session.taskAutonomy.signIn("desktop");
    await h.call("browser_read", {});
    expect(taints(h)).toEqual([{ kind: "screen", origin: "example.com" }]);
  });

  it("a screenshot of a signed-in screen, from the tool or the frame it names", async () => {
    const h = toolHarness();
    await h.call("computer", { action: "screenshot" });
    expect(taints(h)).toEqual([]);
    h.session.taskAutonomy.signIn("desktop");
    const shot = await h.call("computer", { action: "screenshot" });
    expect(taints(h)).toEqual([{ kind: "screen", origin: "desktop screen" }]);

    const fresh = toolHarness();
    fresh.session.taskAutonomy.signIn("desktop");
    const frameId = shot.body.content[0]?.frameId;
    const res = await fresh.app.request(`/v1/frames/${frameId}`, { headers: fresh.auth });
    expect(res.status).toBe(200);
    expect(taints(fresh)).toEqual([{ kind: "screen", origin: "desktop screen" }]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserControl } from "./control.ts";
import type { BrowserGeometrySnapshot } from "./geometry.ts";
import type { BrowserNative } from "./native.ts";
import { BrowserObservation } from "./observation.ts";
import { projectBrowser } from "./perception.ts";
import { BrowserSecrets } from "./secrets.ts";
import type { BrowserDocument } from "./targets.ts";

const identity = {
  browserCellId: "01J00000000000000000000001",
  parentCellId: "01J00000000000000000000002",
  instance: "11111111-1111-4111-8111-111111111111",
};
const owner = { sessionId: "01J00000000000000000000003", generation: 1 };
const permit = { ...identity, revision: 1, requestId: "01J00000000000000000000004", owner };
const signal = () => new AbortController().signal;
const roomValue = "fixture-room-456789";
const secretValue = "private-auth-canary";
const roomAttributes = {
  id: "invite-code",
  "aria-label": "房间码",
  placeholder: "输入 6 位房间码",
  autocomplete: "off",
};

type Field = { tag?: string; attributes: Record<string, string>; value: string };

// The populated room field is the real page's structure; all values are synthetic.
function page(fields: readonly Field[]) {
  const strings: string[] = [];
  const intern = (value: string) => strings.push(value) - 1;
  const nodes = {
    nodeName: ["#document", "HTML", "BODY", "H1", "#text", "BUTTON", "#text"].map(intern),
    parentIndex: [-1, 0, 1, 2, 3, 2, 5],
    backendNodeId: [10, 11, 12, 13, 14, 15, 16],
    attributes: [[], [], [], [], [], [], []] as number[][],
    nodeValue: [-1, -1, -1, -1, intern("Board game"), -1, intern("Play")],
    inputValue: { index: [] as number[], value: [] as number[] },
    textValue: { index: [] as number[], value: [] as number[] },
  };
  const layout = {
    nodeIndex: [2, 3, 4, 5, 6],
    bounds: [
      [0, 0, 1280, 800],
      [20, 20, 300, 40],
      [20, 20, 300, 40],
      [20, 200, 100, 40],
      [20, 200, 100, 40],
    ],
  };
  const accessibility = {
    nodes: [
      {
        ignored: false,
        backendDOMNodeId: 15,
        role: { value: "button" },
        name: { value: "Play" },
        value: { value: "" },
      },
    ],
  };
  for (const field of fields) {
    const position = nodes.nodeName.length;
    nodes.nodeName.push(intern(field.tag ?? "INPUT"));
    nodes.parentIndex.push(2);
    nodes.backendNodeId.push(10 + position);
    nodes.attributes.push(
      Object.entries(field.attributes).flatMap(([key, value]) => [intern(key), intern(value)]),
    );
    nodes.nodeValue.push(-1);
    const column = field.tag === "TEXTAREA" ? nodes.textValue : nodes.inputValue;
    column.index.push(position);
    column.value.push(intern(field.value));
    layout.nodeIndex.push(position);
    layout.bounds.push([20, 80 + (position - 7) * 50, 300, 40]);
    accessibility.nodes.push({
      ignored: false,
      backendDOMNodeId: 10 + position,
      role: { value: field.tag === "DIV" ? "button" : "textbox" },
      name: { value: field.value },
      value: { value: field.value },
    });
  }
  return {
    snapshot: {
      strings,
      documents: [
        {
          frameId: intern("root"),
          documentURL: intern("https://boardgame.example.test/?room=fixture-room"),
          title: intern("Board game"),
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          nodes,
          layout,
        },
      ],
    },
    accessibility,
  };
}

function geometry(tabId = "board"): BrowserGeometrySnapshot {
  return {
    document: { tabId, revision: 1, frame: false },
    content: [0, 0, 1280, 800],
    width: 1280,
    height: 800,
    factor: 1,
    scrollX: 0,
    scrollY: 0,
    focus: "page",
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup(initial: ReturnType<typeof page>) {
  const pages = new Map([["board", initial]]);
  const reload = vi.fn(async (_tabId: string) => {});
  const targets = {
    tabs: () => [...pages.keys()].map((id) => ({ id, ready: true })),
    documents: (tabId: string): BrowserDocument[] => [geometry(tabId).document],
    check: (document: BrowserDocument) => {
      if (!pages.has(document.tabId)) throw new Error("stale");
    },
    command: async (document: BrowserDocument, method: string) => {
      const current = pages.get(document.tabId);
      if (!current) throw new Error("stale");
      if (method === "DOMSnapshot.captureSnapshot") return current.snapshot;
      if (method === "Accessibility.getFullAXTree") return current.accessibility;
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root" } } };
      throw new Error("unsupported fixture command");
    },
    reload,
  };
  const native = {
    command: vi.fn(async () => ({ x: 12, y: 12, cleared: true })),
  } as unknown as Pick<BrowserNative, "command">;
  const secrets = new BrowserSecrets(targets, native);
  const control = new BrowserControl({
    ...identity,
    clearSelections: (s) => secrets.clearSelections(s),
    secretPages: (s) => secrets.secretPages(s),
    reload: (tabId, s) => secrets.reload(tabId, s),
  });
  const capture = {
    masked: vi.fn(async (_mask: unknown, _signal?: AbortSignal) =>
      Buffer.from("masked-board-frame"),
    ),
  };
  const observation = new BrowserObservation({
    control,
    targets,
    scale: 1,
    geometry: { read: async (tabId) => geometry(tabId) },
    secrets,
    native,
    capture,
  });
  cleanups.push(async () => {
    await observation.close();
    await control.close();
  });
  return { pages, secrets, control, observation, reload, capture };
}

describe("public invitation context across browser protection boundaries", () => {
  it("reads and captures the populated room page with field values still redacted", async () => {
    const f = setup(page([{ attributes: roomAttributes, value: roomValue }]));
    await expect(f.control.set({ ...permit, holder: "agent" })).resolves.toMatchObject({
      holder: "agent",
      reloaded: 0,
    });
    const read = await f.observation.read(permit, "board", {}, signal());
    expect(read.text).toContain("Board game");
    expect(read.elements).toContainEqual(expect.objectContaining({ name: "Play", role: "button" }));
    expect(read.elements).toContainEqual(
      expect.objectContaining({ name: "房间码", role: "textbox" }),
    );
    expect(read.elements?.every((element) => !element.secret)).toBe(true);
    expect(JSON.stringify(read)).not.toContain(roomValue);
    const observed = await f.observation.observe(permit, "board", signal());
    expect(observed).toHaveProperty("frame");
    const mask = f.capture.masked.mock.calls[0]?.[0] as
      | { redactions: readonly number[][] }
      | undefined;
    expect(mask?.redactions.length).toBeGreaterThan(0);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it("hands back control without reloading populated room fields in either tab", async () => {
    const f = setup(page([{ attributes: roomAttributes, value: roomValue }]));
    f.pages.set(
      "other-room",
      page([
        {
          attributes: { id: "invitation-code", "aria-label": "Lobby code" },
          value: "another-room",
        },
      ]),
    );
    await f.control.set({ ...permit, holder: "agent" });
    const { owner: _, ...manual } = permit;
    await f.control.set({ ...manual, revision: 2, holder: "user" });
    const resumed = { ...permit, revision: 3 };
    await expect(f.control.set({ ...resumed, holder: "agent" })).resolves.toMatchObject({
      holder: "agent",
      reloaded: 0,
    });
    const lease = f.control.admit(resumed);
    lease.check();
    lease.finish();
    expect(f.reload).not.toHaveBeenCalled();
    expect(f.pages.get("board")?.snapshot.strings).toContain(roomValue);
  });

  it.each<Record<string, string>>([
    { type: "password", "aria-label": "Room code" },
    { ...roomAttributes, autocomplete: "one-time-code" },
    { ...roomAttributes, name: "auth_code" },
    { id: "invitation-code", "aria-label": "Invitation code" },
  ])("keeps genuine or ambiguous protected input blocked: %j", async (attributes) => {
    const source = page([{ attributes, value: secretValue }]);
    expect(() =>
      projectBrowser(source.snapshot, source.accessibility, "root", geometry(), 1, 1000),
    ).toThrow("secret");
    const f = setup(source);
    await expect(f.control.set({ ...permit, holder: "agent" })).rejects.toThrow();
    expect(f.control.holder).toBe("user");
    expect(f.reload).toHaveBeenCalledTimes(1);
    expect(f.capture.masked).not.toHaveBeenCalled();
  });

  it("rechecks the current page so an earlier protected form does not stick to the room", async () => {
    const f = setup(page([{ attributes: roomAttributes, value: roomValue }]));
    await f.control.set({ ...permit, holder: "agent" });
    f.pages.set(
      "board",
      page([{ attributes: { autocomplete: "one-time-code" }, value: secretValue }]),
    );
    await expect(f.observation.read(permit, "board", {}, signal())).rejects.toThrow("secret");
    expect(f.capture.masked).not.toHaveBeenCalled();
    f.pages.set("board", page([{ attributes: roomAttributes, value: roomValue }]));
    const read = await f.observation.read(permit, "board", {}, signal());
    expect(read.text).toContain("Board game");
    expect(JSON.stringify(read)).not.toContain(secretValue);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it("does not classify a non-input game control as an entered authentication field", async () => {
    const f = setup(
      page([
        {
          tag: "DIV",
          attributes: { id: "password-help", "aria-label": "Security code rules" },
          value: "Game help",
        },
      ]),
    );
    await expect(f.control.set({ ...permit, holder: "agent" })).resolves.toMatchObject({
      reloaded: 0,
    });
    await expect(f.observation.read(permit, "board", {}, signal())).resolves.toHaveProperty(
      "title",
      "Board game",
    );
    expect(f.reload).not.toHaveBeenCalled();
  });
});

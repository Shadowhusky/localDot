import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CdpCapabilities, guardCdpCommand } from "./cdp-guard.ts";
import { BrowserNative } from "./native.ts";
import { BrowserSecrets, secretMetadata } from "./secrets.ts";
import { type BrowserDocument, BrowserTargetError } from "./targets.ts";

function snapshot(fields: { tag?: string; attributes?: Record<string, string>; value?: string }[]) {
  const strings: string[] = [];
  const intern = (text: string) => {
    strings.push(text);
    return strings.length - 1;
  };
  const nodes = {
    nodeName: fields.map((field) => intern(field.tag ?? "INPUT")),
    backendNodeId: fields.map((_field, position) => position + 1),
    attributes: fields.map((field) =>
      Object.entries(field.attributes ?? {}).flatMap(([key, value]) => [
        intern(key),
        intern(value),
      ]),
    ),
    inputValue: { index: [] as number[], value: [] as number[] },
    textValue: { index: [] as number[], value: [] as number[] },
  };
  fields.forEach((field, position) => {
    if (field.value !== undefined) {
      const column = field.tag === "TEXTAREA" ? nodes.textValue : nodes.inputValue;
      column.index.push(position);
      column.value.push(intern(field.value));
    }
  });
  return { strings, documents: [{ nodes }] };
}

function fixture() {
  let revision = 1;
  let ready = true;
  let tabIds = ["one"];
  const documents = new WeakSet<object>();
  const calls: string[] = [];
  let response: unknown = snapshot([{ attributes: { type: "password" }, value: "private-canary" }]);
  let hook = async (_method: string) => {};
  const targets = {
    reload: vi.fn(async (_tabId: string, _signal?: AbortSignal) => {
      calls.push("Page.reload");
      await hook("Page.reload");
    }),
    tabs: () => tabIds.map((id) => ({ id, ready })),
    documents: (tabId: string): BrowserDocument[] => {
      const document = { tabId, revision, frame: false };
      documents.add(document);
      return [document];
    },
    check: (document: BrowserDocument) => {
      if (!ready || !documents.has(document) || document.revision !== revision)
        throw new BrowserTargetError("stale");
    },
    command: vi.fn(
      async (
        document: BrowserDocument,
        method: string,
        _params: unknown,
        _signal?: AbortSignal,
      ) => {
        targets.check(document);
        calls.push(method);
        await hook(method);
        targets.check(document);
        return response as Readonly<Record<string, unknown>>;
      },
    ),
  };
  const native = { command: vi.fn(async () => ({ cleared: true })) } as unknown as Pick<
    BrowserNative,
    "command"
  >;
  const secrets = new BrowserSecrets(targets, native);
  return {
    secrets,
    targets,
    native,
    calls,
    signal: new AbortController().signal,
    navigate: () => {
      revision += 1;
    },
    loading: () => {
      ready = false;
    },
    newTab: () => {
      tabIds = [...tabIds, "two"];
    },
    respond: (value: unknown) => {
      response = value;
    },
    intercept: (callback: typeof hook) => {
      hook = callback;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("secret metadata projection", () => {
  it("accepts Chromium's minus-one empty values without accepting invalid indexes", () => {
    const raw = snapshot([{ attributes: { type: "password", hidden: "" }, value: "" }]);
    const nodes = raw.documents[0]?.nodes;
    const attributes = nodes?.attributes[0];
    if (!nodes || !attributes) throw new Error("missing snapshot fixture");
    nodes.inputValue.value[0] = -1;
    attributes[3] = -1;
    expect(secretMetadata(raw)).toEqual({ filled: false, nodeIds: [1] });
    nodes.inputValue.value[0] = -2;
    expect(() => secretMetadata(raw)).toThrow("inspection");
    nodes.inputValue.value[0] = -1;
    attributes[2] = -1;
    expect(() => secretMetadata(raw)).toThrow("inspection");
  });
  it.each<Record<string, string>>([
    { type: "password" },
    { type: "PASSWORD", hidden: "" },
    { autocomplete: "section-login one-time-code" },
    { autocomplete: "current-password" },
    { autocomplete: "NEW-PASSWORD" },
    { name: "otp" },
    { id: "verification_code" },
    { "aria-label": "Security code" },
  ])("recognizes live secrets without returning their values: %j", (attributes) => {
    const result = secretMetadata(snapshot([{ attributes, value: "private-canary" }]));
    expect(result).toEqual({ filled: true, nodeIds: [1] });
    expect(JSON.stringify(result)).not.toContain("canary");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.nodeIds)).toBe(true);
  });

  it("identifies empty protected fields without erasing ordinary filled forms", () => {
    expect(
      secretMetadata(
        snapshot([
          { attributes: { type: "password" }, value: "" },
          { attributes: { autocomplete: "username" }, value: "Richard" },
          { attributes: { id: "search" }, value: "ordinary" },
          { attributes: { id: "password-toggle", type: "button", value: "Show password" } },
        ]),
      ),
    ).toEqual({ filled: false, nodeIds: [1] });
  });

  it("includes textarea live values and retained secret value attributes", () => {
    expect(
      secretMetadata(
        snapshot([
          { tag: "TEXTAREA", attributes: { autocomplete: "one-time-code" }, value: "canary" },
        ]),
      ),
    ).toEqual({ filled: true, nodeIds: [1] });
    expect(
      secretMetadata(snapshot([{ attributes: { type: "password", value: "canary" }, value: "" }])),
    ).toEqual({ filled: true, nodeIds: [1] });
  });

  it.each([
    "unaligned",
    "duplicate",
    "bad-index",
    "odd-attributes",
    "missing-column",
    "empty",
    "duplicate-id",
  ])("refuses malformed snapshot %s without leaking data", (kind) => {
    const raw = snapshot([{ attributes: { type: "password" }, value: "private-canary" }, {}]);
    const nodes = raw.documents[0]?.nodes;
    const attributes = nodes?.attributes[0];
    if (!nodes || !attributes) throw new Error("missing snapshot fixture");
    if (kind === "unaligned") nodes.nodeName.push(0);
    if (kind === "duplicate") {
      nodes.inputValue.index.push(0);
      nodes.inputValue.value.push(0);
    }
    if (kind === "bad-index") nodes.inputValue.value[0] = raw.strings.length;
    if (kind === "odd-attributes") attributes.push(0);
    if (kind === "missing-column") Reflect.deleteProperty(nodes, "inputValue");
    if (kind === "empty") raw.documents = [];
    if (kind === "duplicate-id") nodes.backendNodeId[1] = 1;
    expect(() => secretMetadata(raw)).toThrow(/^Browser secret protection refused: inspection$/u);
  });
});

describe("owned browser handback protection", () => {
  it("returns only affected opaque tab IDs and checks all document handles", async () => {
    const peer = fixture();
    await expect(peer.secrets.secretPages(peer.signal)).resolves.toEqual(["one"]);
    expect(peer.calls).toEqual(["DOMSnapshot.captureSnapshot"]);
    peer.respond(snapshot([{ attributes: { autocomplete: "username" }, value: "Richard" }]));
    await expect(peer.secrets.secretPages(peer.signal)).resolves.toEqual([]);
  });

  it.each(["navigate", "newTab", "loading"] as const)(
    "refuses a changed browser during inspection: %s",
    async (change) => {
      const peer = fixture();
      peer.intercept(async () => {
        peer[change]();
      });
      await expect(peer.secrets.secretPages(peer.signal)).rejects.toThrow("stale");
    },
  );

  it("already aborted work performs zero CDP and native operations", async () => {
    const peer = fixture();
    const abort = new AbortController();
    abort.abort("private-canary");
    await expect(peer.secrets.secretPages(abort.signal)).rejects.toThrow("aborted");
    await expect(peer.secrets.clearSelections(abort.signal)).rejects.toThrow("aborted");
    await expect(peer.secrets.reload("one", abort.signal)).rejects.toThrow("aborted");
    expect(peer.calls).toEqual([]);
    expect(peer.native.command).not.toHaveBeenCalled();
  });

  it("cancellation after a reply cannot publish secret metadata", async () => {
    const peer = fixture();
    const abort = new AbortController();
    peer.intercept(async () => {
      abort.abort();
    });
    await expect(peer.secrets.secretPages(abort.signal)).rejects.toThrow("aborted");
  });

  it("clears selections through the strict native channel", async () => {
    const peer = fixture();
    await peer.secrets.clearSelections(peer.signal);
    expect(peer.native.command).toHaveBeenCalledExactlyOnceWith("clearSelections", {}, peer.signal);
  });

  it("finds focused protected fields but does not mistake ordinary focus for a secret", async () => {
    const peer = fixture();
    peer.intercept(async (method) => {
      if (method === "Accessibility.getFullAXTree")
        peer.respond({
          nodes: [
            { backendDOMNodeId: 1, properties: [{ name: "focused", value: { value: true } }] },
          ],
        });
    });
    await expect(peer.secrets.secretFocused("one", peer.signal)).resolves.toBe(true);
    peer.respond(snapshot([{ attributes: { autocomplete: "username" }, value: "Richard" }]));
    await expect(peer.secrets.secretFocused("one", peer.signal)).resolves.toBe(false);
  });

  it("reload waits for a changed document and tolerates its own navigation invalidation", async () => {
    const peer = fixture();
    peer.intercept(async (method) => {
      if (method === "Page.reload") peer.navigate();
    });
    await expect(peer.secrets.reload("one", peer.signal)).resolves.toBeUndefined();
    expect(peer.calls).toEqual(["Page.reload"]);
  });

  it("a rejected owned reload cannot claim cleanup", async () => {
    const peer = fixture();
    peer.targets.reload.mockRejectedValueOnce(new Error("private-canary"));
    await expect(peer.secrets.reload("one", peer.signal)).rejects.toThrow(
      /^Browser secret protection refused: cleanup$/u,
    );
  });
});

describe("new command boundaries", () => {
  const capabilities: CdpCapabilities = {
    downloadDir: "/tmp/downloads",
    uploadDir: "/tmp/uploads",
    ownsTarget: () => false,
    ownsSession: (session) => session === "owned",
    ownsWindow: () => false,
    ownsNode: () => false,
    ownsDownload: () => false,
    allowsUpload: () => false,
  };
  it("allows only the empty style snapshot on a known page session", () => {
    expect(
      guardCdpCommand("DOMSnapshot.captureSnapshot", { computedStyles: [] }, capabilities, "owned")
        .method,
    ).toBe("DOMSnapshot.captureSnapshot");
    for (const session of [undefined, "foreign"])
      expect(() =>
        guardCdpCommand(
          "DOMSnapshot.captureSnapshot",
          { computedStyles: [] },
          capabilities,
          session,
        ),
      ).toThrow("scope");
    for (const params of [
      { computedStyles: ["content"] },
      { computedStyles: [], includePaintOrder: true },
      {},
    ])
      expect(() =>
        guardCdpCommand("DOMSnapshot.captureSnapshot", params, capabilities, "owned"),
      ).toThrow("params");
    expect(() => guardCdpCommand("DOMSnapshot.getSnapshot", {}, capabilities, "owned")).toThrow(
      "method",
    );
  });

  it("native selection acknowledgement must explicitly confirm clearing", async () => {
    const output = new PassThrough();
    const writes: Record<string, unknown>[] = [];
    const input = new Writable({
      write(chunk, _encoding, done) {
        writes.push(JSON.parse(chunk.toString()));
        done();
      },
    });
    const native = new BrowserNative({ input, output, scale: 2, onFatal: vi.fn() });
    try {
      output.write(Buffer.from(`${JSON.stringify({ ev: "ready", mono: 1 })}\n`));
      const pending = native.command("clearSelections", {});
      expect(writes).toEqual([{ id: 1, cmd: "clearSelections" }]);
      output.write(Buffer.from(`${JSON.stringify({ id: 1, ok: true, cleared: false })}\n`));
      await expect(pending).rejects.toThrow("protocol");
      expect(native.alive).toBe(false);
    } finally {
      native.close();
    }
  });
});

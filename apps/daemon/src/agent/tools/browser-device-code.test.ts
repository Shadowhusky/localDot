import type { BrowserAction, PageElement, Target } from "@localdot/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizePrepared } from "../safety/authorize.ts";
import { classify } from "../safety/classify.ts";
import { outboundOf } from "../safety/purpose.ts";
import { browserDeviceCodeTool } from "./browser-device-code.ts";
import type { ToolCallContext, ToolDeps } from "./deps.ts";
import { findSecretField, typeSecret } from "./secret-field.ts";

vi.mock("../safety/authorize.ts", () => ({ authorizePrepared: vi.fn() }));
vi.mock("./secret-field.ts", () => ({ findSecretField: vi.fn(), typeSecret: vi.fn() }));
vi.mock("./deps.ts", async (original) => ({
  ...(await original<object>()),
  append: vi.fn(),
  screenContext: () => ({}),
}));
const url = "https://github.com/login/device";
const element: PageElement = {
  ref: "e42",
  role: "textbox",
  name: "User code 0",
  secret: true,
  box: { x: 100, y: 100, w: 30, h: 30 },
};
const target: Target = {
  source: "dom",
  role: element.role,
  name: element.name,
  secret: true,
  editable: true,
  url,
  point: { x: 115, y: 115 },
  bbox: element.box,
};
const input: BrowserAction = {
  action: "device_code",
  ref: "e42",
  text: "ABCD-EFGH",
  origin: "https://github.com",
  intent: "Authorize the requested GitHub CLI",
};
function setup() {
  const find = vi.fn(async () => target);
  const ctx = {
    check() {},
    screen: { selection: { screen: "browser" } },
    nativeScreen: { scale: 1 },
  } as unknown as ToolCallContext;
  const deps = { gateway: { find } } as unknown as ToolDeps;
  const consume = vi.fn(() => true);
  vi.mocked(authorizePrepared).mockResolvedValue({ approved: true, consume });
  vi.mocked(findSecretField).mockResolvedValue({
    screen: { name: "browser", cellId: "browser", revision: 1 },
    at: target.point,
    found: { target, point: target.point, window: null },
  });
  vi.mocked(typeSecret).mockResolvedValue({ filled: true, submitted: true });
  return {
    find,
    ctx,
    deps,
    consume,
    call: (change: Partial<BrowserAction> = {}, field = element, page = url) =>
      browserDeviceCodeTool(deps, ctx, { ...input, ...change }, field, page),
  };
}
beforeEach(() => vi.resetAllMocks());
describe("known CLI device-code entry", () => {
  it("binds private entry to the current node and origin, authorizes account linking and requires verification", async () => {
    const h = setup();
    const result = await h.call();
    expect(result.ok).toBe(true);
    expect(typeSecret).toHaveBeenCalledWith(
      h.deps,
      h.ctx,
      expect.any(Object),
      input.text,
      undefined,
      { purpose: "device_code", node: 42 },
    );
    expect(authorizePrepared).toHaveBeenCalledWith(
      h.ctx,
      expect.objectContaining({
        tool: "browser_act",
        facts: expect.objectContaining({ operation: "device_code" }),
      }),
    );
    expect(h.consume).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(input.text);
    expect(JSON.stringify(result)).toContain("verify CLI authentication");
  });
  it.each([
    { origin: "https://evil.test" },
    { origin: undefined },
    { text: "" },
    { text: "123\n456" },
    { coordinate: [100, 100] },
    { submit: true },
  ])("refuses invalid or ambiguous delivery before authorization: %j", async (change) => {
    const h = setup();
    expect((await h.call(change)).ok).toBe(false);
    expect(typeSecret).not.toHaveBeenCalled();
    expect(authorizePrepared).not.toHaveBeenCalled();
  });
  it("requires a current protected field on the browser screen", async () => {
    const h = setup();
    expect((await h.call({}, { ...element, secret: undefined })).ok).toBe(false);
    Object.assign(h.ctx, { screen: { selection: { screen: "desktop" } } });
    expect((await h.call()).ok).toBe(false);
    expect(typeSecret).not.toHaveBeenCalled();
  });
  it("does not type when account linking is denied", async () => {
    const h = setup();
    vi.mocked(authorizePrepared).mockResolvedValue(undefined);
    expect((await h.call()).ok).toBe(false);
    expect(typeSecret).not.toHaveBeenCalled();
  });
  it("does not use coordinates as fallback after the field changes", async () => {
    const h = setup();
    h.find.mockResolvedValueOnce(target).mockResolvedValue({ ...target, name: "Other field" });
    expect((await h.call()).ok).toBe(false);
    expect(typeSecret).not.toHaveBeenCalled();
  });
  it("classifies linking as account settings and checks the actual outbound destination", () => {
    const facts = { operation: "device_code" as const, target: { ...target, fresh: true } };
    expect(classify(facts)).toEqual(["system_settings"]);
    expect(outboundOf("browser_act", input, facts)).toEqual([
      { kind: "enter_text", destination: "github.com", text: input.text },
    ]);
    expect(classify({ operation: "type", target: { ...target, fresh: true } })).toEqual([
      "credentials",
    ]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AskFieldValue,
  HitTestResult,
  InputRequest,
  Target,
  TypeRequest,
} from "@localdot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeDevice } from "../../desktopd/registry.ts";
import { Conversations } from "../conversation.ts";
import { redactor } from "../redact.ts";
import { PROXY_TOKEN, toolHarness } from "../testing/harness.ts";
import { dispatchTool } from "./index.ts";

const SECRET = "correct horse battery staple 42";
const PASSWORD: Target = {
  point: { x: 800, y: 600 },
  bbox: { x: 640, y: 580, w: 320, h: 40 },
  source: "dom",
  role: "textbox",
  name: "Password",
  app: "chromium",
  window: "Sign in",
  url: "https://mail.example.test/login",
  secret: true,
};
const FRAME = { x: 0, y: 0, w: 2560, h: 1600 };
const LOGIN = {
  question: "Sign in to your mail so I can read the latest message",
  fields: [
    { id: "email", kind: "email", label: "Email" },
    { id: "password", kind: "secret", label: "Password", target: [400, 300] },
  ],
  submit: "Sign in",
  decline: "Not now",
};

function device() {
  const hit: HitTestResult = { target: PASSWORD, window: 7, windowFrame: FRAME, ms: 1 };
  const state = {
    hit,
    // Keyboard focus reports the element's centre, a hit test the point it was asked about.
    focus: { ...hit, target: { ...PASSWORD, point: { x: 800, y: 600 } } } as HitTestResult,
    calls: [] as string[],
    typed: [] as TypeRequest[],
    typeError: undefined as Error | undefined,
    // How many characters the device says it typed, when not all of them.
    typedCount: undefined as number | undefined,
  };
  const client = {
    hitTest: async (point: { x: number; y: number }) => {
      state.calls.push(`hit ${point.x},${point.y}`);
      return state.hit;
    },
    focused: async () => {
      state.calls.push("focused");
      return state.focus;
    },
    input: async (request: InputRequest) => {
      const { input } = request;
      if (input.kind === "key") state.calls.push(`key ${input.combo.join("+")}`);
      else {
        const at = input.kind === "click" ? input.at : undefined;
        state.calls.push(`click ${at?.x},${at?.y} window ${request.window}`);
      }
      return { pressMono: 1, presses: [1], injector: "xtest" as const, armedMono: 0 };
    },
    type: async (request: TypeRequest) => {
      state.calls.push("type");
      if (state.typeError) throw state.typeError;
      state.typed.push(request);
      return {
        done: true as const,
        count: state.typedCount ?? [...request.text].length,
        firstPressMono: 1,
        injector: "xtest" as const,
        armedMono: 0,
      };
    },
  };
  return { state, device: { client } as unknown as NativeDevice };
}

const fixtures: ReturnType<typeof toolHarness>[] = [];
afterEach(() => {
  for (const h of fixtures.splice(0)) h.close();
});

function setup() {
  const h = toolHarness();
  fixtures.push(h);
  const d = device();
  h.tools.device = () => d.device;
  const redact = redactor([PROXY_TOKEN]);
  const call = (input: unknown) =>
    dispatchTool({ tools: h.tools }, h.session, "ask_user", "call", input, redact);
  const asked = async () => {
    for (let i = 0; i < 500 && !h.session.pendingAsk; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const askId = h.session.pendingAsk;
    if (!askId) throw new Error("the question never arrived");
    return askId;
  };
  // Every byte the daemon stored under its home: event log, index, transcripts, conversation.
  const stored = () => {
    const files = readdirSync(h.home, { recursive: true, withFileTypes: true }).filter((entry) =>
      entry.isFile(),
    );
    return files.map((entry) =>
      readFileSync(join(entry.parentPath, entry.name)).toString("latin1"),
    );
  };
  return { ...h, ...d, call, asked, stored };
}
const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((c) => c.text ?? "").join("\n");

describe("ask_user with fields", () => {
  it("types a secret into the field dot named and never stores it or shows it to the model", async () => {
    const h = setup();
    const asking = h.call(LOGIN);
    const askId = await h.asked();
    const request = h.events().find((e) => e.type === "ask.request");
    expect(request?.data).toMatchObject({
      question: LOGIN.question,
      options: [],
      allowText: false,
      submit: "Sign in",
      decline: "Not now",
      fields: [
        { id: "email", kind: "email", label: "Email" },
        {
          id: "password",
          kind: "secret",
          label: "Password",
          target: {
            screen: "desktop",
            point: { x: 800, y: 600 },
            bbox: PASSWORD.bbox,
            site: "mail.example.test",
          },
        },
      ],
    });
    expect(h.state.calls).toEqual(["hit 800,600"]);

    const accepted = h.session.answerFields(
      askId,
      { email: " ada@example.test ", password: SECRET },
      (text) => text,
    );
    expect(accepted).toBe(true);
    const { result } = await asking;

    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain(
      'The user answered: {"email":"ada@example.test","password":{"provided":true}}',
    );
    expect(h.state.calls).toEqual([
      "hit 800,600",
      "hit 800,600",
      "click 800,600 window 7",
      "focused",
      "key ctrl+a",
      "type",
    ]);
    expect(h.state.typed).toEqual([
      {
        text: SECRET,
        masked: true,
        pace: { firstMs: 0, firstCount: 0, restMs: 0 },
        injector: "xtest",
        window: 7,
      },
    ]);
    const answer = h.events().find((e) => e.type === "ask.answer");
    expect(answer?.data).toEqual({
      askId,
      fields: { email: "ada@example.test", password: { provided: true } },
      by: "user",
    });
    expect(h.session.taskAutonomy.signedIn("desktop")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(h.events())).not.toContain(SECRET);
    const conversation = new Conversations(h.home, h.eventLog);
    expect(conversation.earlier(h.session.id).join("\n")).toContain(
      "The user answered: Email: ada@example.test\nPassword: (given, kept secret)",
    );
    for (const file of h.stored()) expect(file).not.toContain(SECRET);
  });

  it("types into the field that has keyboard focus when dot names no point", async () => {
    const h = setup();
    const asking = h.call({
      question: "What is the Wi-Fi password?",
      fields: [{ id: "wifi", kind: "secret", label: "Wi-Fi password" }],
    });
    const askId = await h.asked();
    expect(h.session.answerFields(askId, { wifi: SECRET }, (text) => text)).toBe(true);
    const { result } = await asking;
    expect(result.ok).toBe(true);
    expect(h.state.calls).toEqual(["focused", "focused", "key ctrl+a", "type"]);
    expect(h.state.typed.map((t) => t.text)).toEqual([SECRET]);
  });

  it("types nothing and says the field moved when the target changed while the user answered", async () => {
    const h = setup();
    const asking = h.call(LOGIN);
    const askId = await h.asked();
    h.state.hit = { ...h.state.hit, target: { ...PASSWORD, bbox: { ...FRAME, y: 900, h: 40 } } };
    h.session.answerFields(askId, { email: "ada@example.test", password: SECRET }, (t) => t);
    const { result } = await asking;
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("The secure answer was not delivered.");
    expect(textOf(result)).toContain('{"email":"ada@example.test"}');
    expect(h.state.calls).toEqual(["hit 800,600", "hit 800,600"]);
    expect(h.state.typed).toEqual([]);
    expect(h.session.taskAutonomy.signedIn("desktop")).toBe(false);
  });

  it("types nothing when another window took the point or keyboard focus went elsewhere", async () => {
    for (const change of [
      (s: ReturnType<typeof device>["state"]) => {
        s.hit = { ...s.hit, window: 9 };
      },
      (s: ReturnType<typeof device>["state"]) => {
        s.focus = { ...s.focus, target: { ...PASSWORD, name: "Search", secret: false } };
      },
    ]) {
      const h = setup();
      const asking = h.call(LOGIN);
      const askId = await h.asked();
      change(h.state);
      h.session.answerFields(askId, { email: "ada@example.test", password: SECRET }, (t) => t);
      const { result } = await asking;
      expect(textOf(result)).toContain("The secure answer was not delivered.");
      expect(h.state.typed).toEqual([]);
    }
  });

  it("refuses before asking when there is no field to type into", async () => {
    const h = setup();
    h.state.hit = { target: null, window: 7, windowFrame: FRAME, ms: 1 };
    const { result } = await h.call(LOGIN);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("There is no text field at that target");
    expect(h.session.pendingAsk).toBeUndefined();
    expect(h.events().some((e) => e.type === "ask.request")).toBe(false);
  });

  it("refuses a field that shows what is typed, by its point or by keyboard focus", async () => {
    for (const ask of [
      LOGIN,
      { question: "Sign in", fields: [{ id: "password", kind: "secret", label: "Password" }] },
    ]) {
      const h = setup();
      const search = { ...PASSWORD, role: "entry", name: "Search", editable: true, secret: false };
      h.state.hit = { ...h.state.hit, target: search };
      h.state.focus = { ...h.state.focus, target: search };
      const { result } = await h.call(ask);
      expect(result.ok).toBe(false);
      expect(textOf(result)).toContain("shows what is typed, so a secret can't go there");
      expect(h.session.pendingAsk).toBeUndefined();
      expect(h.events().some((e) => e.type === "ask.request")).toBe(false);
    }
  });

  it("refuses a target off the screen before looking at it", async () => {
    const h = setup();
    const { result } = await h.call({
      ...LOGIN,
      fields: [{ id: "password", kind: "secret", label: "Password", target: [1280, 300] }],
    });
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("The target (1280, 300) is outside the 1280x800 screen.");
    expect(h.state.calls).toEqual([]);
    expect(h.events().some((e) => e.type === "ask.request")).toBe(false);
  });

  it("says typing could not be confirmed when the device typed fewer characters", async () => {
    const h = setup();
    h.state.typedCount = 3;
    const asking = h.call(LOGIN);
    const askId = await h.asked();
    h.session.answerFields(askId, { email: "ada@example.test", password: SECRET }, (t) => t);
    const { result } = await asking;
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("Typing the answer for password could not be confirmed");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("keeps the device's own error text, which could quote the secret, out of the result and log", async () => {
    const h = setup();
    h.state.typeError = new Error(`desktopd 500 on /type: stuck after "${SECRET}"`);
    const asking = h.call(LOGIN);
    const askId = await h.asked();
    h.session.answerFields(askId, { email: "ada@example.test", password: SECRET }, (t) => t);
    const { result } = await asking;
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("Typing the answer for password could not be confirmed");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    for (const file of h.stored()) expect(file).not.toContain(SECRET);
  });

  it("tells dot the user declined", async () => {
    const h = setup();
    const asking = h.call(LOGIN);
    const askId = await h.asked();
    expect(h.session.decline(askId)).toBe(true);
    const { result } = await asking;
    expect(result.ok).toBe(true);
    expect(textOf(result)).toContain("The user declined (Not now).");
    expect(h.state.typed).toEqual([]);
    expect(h.events().find((e) => e.type === "ask.answer")?.data).toEqual({
      askId,
      declined: true,
      by: "user",
    });
  });

  it("takes answers only for its own fields, each valid for its kind", async () => {
    const h = setup();
    const asking = h.call({
      question: "Where should the report go?",
      fields: [
        { id: "format", kind: "choice", label: "Format", options: ["PDF", "Word"] },
        { id: "extras", kind: "multichoice", label: "Include", options: ["Charts", "Notes"] },
        { id: "code", kind: "code", label: "Code from your phone", length: 6 },
      ],
    });
    const askId = await h.asked();
    const keep = (text: string) => text;
    const wrong: Record<string, AskFieldValue>[] = [
      { format: "PDF", extras: ["Charts"] },
      { format: "PDF", extras: ["Charts"], code: "12345" },
      { format: "PDF", extras: ["Slides"], code: "123456" },
      { format: "PDF", extras: [], code: "123456", other: "x" },
    ];
    for (const values of wrong) expect(h.session.answerFields(askId, values, keep)).toBe(false);
    expect(h.session.answer(askId, "A", undefined)).toBe(false);
    expect(
      h.session.answerFields(askId, { format: "Markdown", extras: [], code: "123456" }, keep),
    ).toBe(true);
    const { result } = await asking;
    expect(textOf(result)).toContain(
      'The user answered: {"format":"Markdown","extras":[],"code":{"provided":true}}',
    );
    expect(h.state.typed.at(-1)?.text).toBe("123456");
    expect(textOf(result)).not.toContain("123456");
    expect(h.stored().join("\n")).not.toContain("123456");
  });

  it("keeps a plain question with options working as before", async () => {
    const h = setup();
    const asking = h.call({ question: "Which format?", options: ["PDF", "Word"] });
    const askId = await h.asked();
    expect(h.events().find((e) => e.type === "ask.request")?.data).toEqual({
      askId,
      question: "Which format?",
      options: [
        { key: "A", text: "PDF" },
        { key: "B", text: "Word" },
      ],
      allowText: false,
    });
    expect(h.session.answerFields(askId, { answer: "PDF" }, (t) => t)).toBe(false);
    expect(h.session.answer(askId, "B", undefined)).toBe(true);
    const { result } = await asking;
    expect(textOf(result)).toBe("The user chose B: Word");
    expect(h.state.calls).toEqual([]);
  });
});

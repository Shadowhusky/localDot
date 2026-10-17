// @vitest-environment jsdom
/// <reference types="node" />
import { webcrypto } from "node:crypto";
import { toBase64url } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyForm, type KeyIntake } from "../keys/KeyForm.tsx";
import { type Seal, saveKey } from "../keys/keys-api.ts";
import { createApi } from "../lib/api.ts";
import { KeyFound } from "./KeyFound.tsx";
import { type KeyGuard, useKeyGuard } from "./useKeyGuard.ts";

const keys = [
  `sk-ant-api03-${"a".repeat(95)}`,
  `sk-ant-admin01-${"b".repeat(95)}`,
  `sk-proj-${"c".repeat(156)}`,
  `sk-svcacct-${"d".repeat(156)}`,
  `sk-admin-${"e".repeat(156)}`,
  `AIza${"f".repeat(35)}`,
  `AQ.${"g".repeat(128)}`,
  `gsk_${"h".repeat(52)}`,
  `sk-or-v1-${"i".repeat(64)}`,
  `xai-${"j".repeat(64)}`,
  `pplx-${"k".repeat(48)}`,
  `sk-${"a".repeat(32)}`,
];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const keyChoice = () => screen.getByRole("combobox", { name: "Key to move" });
// Opens the key list, moves down to row `index` and chooses it, from the keyboard.
function chooseKey(index: number) {
  const trigger = keyChoice();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Home" });
  fireEvent.keyDown(trigger, { key: "Home" });
  for (let step = 0; step < index; step++) fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

function fixture(
  options: { active?: boolean; keyActive?: boolean; disabled?: boolean; seal?: Seal } = {},
) {
  const calls: { path: string; body: string }[] = [];
  let publicKey = "invalid-key";
  const api = createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, body: String(init?.body ?? "") });
      if (path === "/api/keyd") return Response.json({ online: true, sealKey: publicKey });
      if (path === "/api/keys") {
        const { binding } = JSON.parse(String(init?.body)) as { binding: Record<string, unknown> };
        return Response.json({
          key: { ...binding, createdAt: "2026-10-03T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" },
          restart: false,
        });
      }
      return Response.json({ sessionId: "fixture" });
    },
  });
  const metadata: string[] = [];
  let current!: KeyGuard;
  function Harness({ active = true, keyActive = true, disabled = false }: typeof options) {
    const guard = useKeyGuard(active);
    current = guard;
    metadata.push(JSON.stringify(guard.notice));
    const intake = useRef<KeyIntake>(null);
    return (
      <>
        <form
          aria-label="Task composer"
          onSubmit={(event) => {
            event.preventDefault();
            const field = event.currentTarget.querySelector("textarea");
            if (field && guard.check(field))
              void api.post("/api/cells/fixture/agent", { task: field.value });
          }}
        >
          <label>
            Task
            <textarea onInput={(event) => guard.check(event.currentTarget)} />
          </label>
          <button type="submit">Send task</button>
        </form>
        <KeyFound
          guard={guard}
          receive={(source, provider) => intake.current?.receive(source, provider) ?? false}
        />
        <KeyForm
          active={keyActive}
          unavailable={disabled ? "Key protection is off" : undefined}
          intakeRef={intake}
          save={async (binding, value) => saveKey(api, binding, value, options.seal)}
        />
      </>
    );
  }
  const view = render(<Harness {...options} />);
  const task = screen.getByLabelText("Task") as HTMLTextAreaElement;
  const keyField = screen.getByLabelText("Key") as HTMLInputElement;
  const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Task composer" }));
  return {
    ...view,
    task,
    keyField,
    calls,
    metadata,
    submit,
    get guard() {
      return current;
    },
    rerenderOptions: (next: typeof options) => view.rerender(<Harness {...next} />),
    setPublic: (value: string) => {
      publicKey = value;
    },
  };
}
function absent(f: ReturnType<typeof fixture>) {
  const ordinary = JSON.stringify({
    calls: f.calls,
    metadata: f.metadata,
    local: { ...localStorage },
    session: { ...sessionStorage },
    url: location.href,
    markup: document.body.innerHTML,
    text: document.body.textContent,
    draft: f.task.value,
  });
  for (const key of keys) expect(ordinary).not.toContain(key);
}

describe("key guard at the composer and sealed form boundary", () => {
  it.each(keys.map((key, index) => ({ key, index })))(
    "blocks synthetic shape $index on input and at submit without an input handler",
    async ({ key }) => {
      const f = fixture();
      // A script, IME or missed paste handler still passes through submit's final check.
      f.task.value = `请处理 '${key}.example' please`;
      f.submit();
      expect(f.calls).toEqual([]);
      expect(f.task.value).not.toContain(key);
      expect(screen.getByRole("alert").textContent).toContain("taken out");
      absent(f);
      f.submit();
      expect(f.calls).toEqual([]);
      expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Discard key" }));
      expect(document.activeElement).toBe(f.task);
      f.submit();
      await act(async () => {});
      expect(f.calls).toEqual([
        { path: "/api/cells/fixture/agent", body: JSON.stringify({ task: f.task.value }) },
      ]);
      expect(f.task.value).toContain("请处理");
      fireEvent.input(f.task, { target: { value: key } });
      expect(f.task.value).toBe("");
      expect(f.guard.notice?.kind).toBe("found");
      absent(f);
    },
  );
  it("erases an unadmitted field when a forged submit arrives after close", () => {
    const f = fixture({ active: false, keyActive: false });
    f.task.value = keys[0] ?? "";
    f.submit();
    expect(f.calls).toEqual([]);
    expect(f.task.value).toBe("");
    expect(f.guard.notice).toBeNull();
    absent(f);
  });
  it("moves exactly the selected DOM-owned candidate, discards the others, then seals before network", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    const f = fixture();
    f.setPublic(
      toBase64url(new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey))),
    );
    fireEvent.input(f.task, { target: { value: `before ${keys[0]} then ${keys[7]} after` } });
    expect(screen.getByRole("button", { name: "Discard keys" })).toBeTruthy();
    chooseKey(1);
    fireEvent.click(screen.getByRole("button", { name: "Move to Keys" }));
    expect(f.task.value).toBe("before  then  after");
    expect(f.keyField.value).toBe(keys[7]);
    expect(screen.getByLabelText("Provider").textContent).toBe("Groq");
    expect(f.guard.notice).toBeNull();
    expect(f.calls).toEqual([]);
    absent(f); // DOM.value is the sole allowed remaining plaintext owner, not attributes/markup.
    fireEvent.change(screen.getByLabelText("Key ID (optional)"), { target: { value: "provider" } });
    fireEvent.submit(screen.getByRole("form", { name: "Add a key" }));
    expect(f.keyField.value).toBe("");
    await screen.findByText("Saved provider.");
    expect(f.calls.map((c) => c.path)).toEqual(["/api/keyd", "/api/keys"]);
    const saved = JSON.parse(f.calls[1]?.body ?? "{}");
    expect(saved.binding).toEqual({ kind: "llm", id: "provider", provider: "groq" });
    expect(saved.sealed).toMatchObject({
      v: 1,
      epk: expect.any(String),
      nonce: expect.any(String),
      ct: expect.any(String),
    });
    expect(saved.sealed.ct.length).toBeGreaterThan(20);
    expect(saved).not.toHaveProperty("value");
    absent(f);
  });
  it("clears on a synchronous sealing error and requires repaste without a plaintext request", async () => {
    const f = fixture({
      seal: () => {
        throw new Error(keys[0]);
      },
    });
    fireEvent.input(f.task, { target: { value: keys[0] } });
    fireEvent.click(screen.getByRole("button", { name: "Move to Keys" }));
    fireEvent.change(screen.getByLabelText("Key ID (optional)"), { target: { value: "provider" } });
    fireEvent.submit(screen.getByRole("form", { name: "Add a key" }));
    await screen.findByRole("alert");
    expect(f.keyField.value).toBe("");
    expect(document.body.textContent).toContain("Paste the key again");
    expect(f.calls.map((c) => c.path)).toEqual(["/api/keyd"]);
    absent(f);
  });
  it.each(["offline", "close", "pagehide", "hidden", "unmount"] as const)(
    "clears both possible owners on %s and never restores the chat draft",
    (action) => {
      const f = fixture();
      fireEvent.input(f.task, { target: { value: keys[0] } });
      fireEvent.click(screen.getByRole("button", { name: "Move to Keys" }));
      expect(f.keyField.value).toBe(keys[0]);
      if (action === "offline") f.rerenderOptions({ disabled: true });
      else if (action === "close") f.rerenderOptions({ active: false, keyActive: false });
      else if (action === "pagehide") fireEvent(window, new Event("pagehide"));
      else if (action === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        fireEvent(document, new Event("visibilitychange"));
      } else f.unmount();
      expect(f.keyField.value).toBe("");
      expect(f.task.value).toBe("");
      expect(f.calls).toEqual([]);
      absent(f);
    },
  );
  it.each(["cancel", "close", "pagehide", "hidden", "unmount"] as const)(
    "discards a held candidate on %s so a retained Move callback cannot deliver it",
    (action) => {
      const f = fixture();
      fireEvent.input(f.task, { target: { value: keys[0] } });
      const retained = f.guard;
      if (action === "cancel") act(() => retained.cancel());
      else if (action === "close") f.rerenderOptions({ active: false, keyActive: false });
      else if (action === "pagehide") fireEvent(window, new Event("pagehide"));
      else if (action === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        fireEvent(document, new Event("visibilitychange"));
      } else f.unmount();
      const receive = vi.fn(() => true);
      act(() => {
        expect(retained.move(0, receive)).toBe(false);
      });
      expect(receive).not.toHaveBeenCalled();
      expect(f.task.value).toBe("");
      expect(f.keyField.value).toBe("");
      absent(f);
    },
  );
  it("says a Claude plan token can't be used here and never offers to move it to Keys", () => {
    const SENTENCE =
      "Claude plan tokens can't be used here: Anthropic doesn't allow other apps to sign in with them. To use your plan, choose Claude Code (your plan) in Settings, or add an Anthropic API key.";
    const token = `sk-ant-oat01-${"m".repeat(95)}`;
    const f = fixture();
    fireEvent.input(f.task, { target: { value: `use ${token} for this` } });
    expect(f.task.value).toBe("use  for this");
    const safeguard = screen.getByRole("region", { name: "Key safeguard" });
    expect(safeguard.textContent).toContain("Claude plan token removed");
    expect(screen.getByRole("alert").textContent).toBe(SENTENCE);
    expect(screen.queryByRole("button", { name: "Move to Keys" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard key" }));
    fireEvent.input(f.task, { target: { value: `${token} ${keys[0]}` } });
    fireEvent.keyDown(keyChoice(), { key: "ArrowDown" });
    const list = within(screen.getByRole("listbox", { name: "Key to move" }));
    expect(list.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Claude plan token · character 1",
      "Anthropic · character 110",
    ]);
    fireEvent.keyDown(keyChoice(), { key: "Escape" });
    expect(screen.getByText(SENTENCE)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Move to Keys" })).toBeNull();
    chooseKey(1);
    expect(screen.queryByText(SENTENCE)).toBeNull();
    expect(screen.getByRole("button", { name: "Move to Keys" })).toBeTruthy();
    expect(f.calls).toEqual([]);
    expect(document.body.innerHTML + f.metadata.join("")).not.toContain(token);
    absent(f);
  });
  it("offers no key to move when every key found is a Claude plan token", () => {
    const SENTENCE =
      "Claude plan tokens can't be used here: Anthropic doesn't allow other apps to sign in with them. To use your plan, choose Claude Code (your plan) in Settings, or add an Anthropic API key.";
    const f = fixture();
    fireEvent.input(f.task, {
      target: { value: `sk-ant-oat01-${"m".repeat(95)} sk-ant-ort01-${"n".repeat(95)}` },
    });
    expect(screen.getByRole("region", { name: "Key safeguard" }).textContent).toContain(
      "Claude plan tokens removed",
    );
    expect(screen.getByRole("alert").textContent).toBe(SENTENCE);
    expect(screen.queryByRole("combobox", { name: "Key to move" })).toBeNull();
    expect(screen.queryByText(/Moving one key/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to Keys" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard keys" }));
    expect(f.task.value).toBe(" ");
    expect(f.calls).toEqual([]);
  });
  it("starts each new notice on its first key, not the one chosen in an earlier notice", () => {
    const f = fixture();
    fireEvent.input(f.task, { target: { value: `${keys[0]} ${keys[2]}` } });
    chooseKey(1);
    expect(keyChoice().textContent).toContain("character 110");
    fireEvent.click(screen.getByRole("button", { name: "Discard keys" }));
    fireEvent.input(f.task, { target: { value: `${keys[2]} sk-ant-oat01-${"m".repeat(95)}` } });
    expect(keyChoice().textContent).toContain("character 1");
    expect(keyChoice().textContent).not.toContain("Claude plan token");
    expect(screen.getByRole("button", { name: "Move to Keys" })).toBeTruthy();
    expect(screen.queryByText(/Claude Pro and Max plans/)).toBeNull();
    absent(f);
  });
  it("fails closed at finite character and candidate limits, and Remove does not restore overflow text", () => {
    const f = fixture();
    for (const text of ["x".repeat(8001), Array(17).fill(keys[5]).join(" ")]) {
      f.task.value = text;
      f.submit();
      expect(f.guard.notice?.kind).toBe("overflow");
      expect(f.task.value).toBe("");
      expect(f.calls).toEqual([]);
      expect(screen.queryByRole("button", { name: "Move to Keys" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
      expect(f.guard.notice).toBeNull();
      expect(f.task.value).toBe("");
    }
  });
  it("clears the one-shot source in finally even when the receiver throws before touching it", () => {
    const f = fixture();
    fireEvent.input(f.task, { target: { value: keys[0] } });
    let source!: HTMLInputElement;
    act(() => {
      expect(
        f.guard.move(0, (input) => {
          source = input;
          expect(input.value).toBe(keys[0]);
          throw new Error("synchronous intake failure");
        }),
      ).toBe(false);
    });
    expect(source.value).toBe("");
    expect(f.task.value).toBe("");
    expect(f.guard.notice).toEqual({ kind: "transfer_failed", candidates: [] });
    absent(f);
  });
  it("discards a failed or throwing one-shot transfer and guards reentrant Move", () => {
    const f = fixture();
    fireEvent.input(f.task, { target: { value: keys[0] } });
    let source!: HTMLInputElement;
    const nested = vi.fn(() => true);
    act(() => {
      expect(
        f.guard.move(0, (input) => {
          source = input;
          expect(f.guard.move(0, nested)).toBe(false);
          throw new Error("private failure");
        }),
      ).toBe(false);
    });
    expect(nested).not.toHaveBeenCalled();
    expect(source.value).toBe("");
    expect(f.guard.notice).toEqual({ kind: "transfer_failed", candidates: [] });
    expect(f.calls).toEqual([]);
    absent(f);
  });
  it("cancels a transfer when focus hides the page during handoff", () => {
    const f = fixture();
    fireEvent.input(f.task, { target: { value: keys[0] } });
    f.keyField.addEventListener("focus", () => window.dispatchEvent(new Event("pagehide")), {
      once: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Move to Keys" }));
    expect(f.keyField.value).toBe("");
    expect(f.task.value).toBe("");
    expect(f.guard.notice?.kind).toBe("transfer_failed");
    absent(f);
  });
  it("does not let a retained intake handle bypass offline/closed/busy state", async () => {
    const intake = createRef<KeyIntake>();
    const pending = Promise.withResolvers<{ restart: boolean }>();
    const save = vi.fn(() => pending.promise);
    const view = render(<KeyForm active save={save} intakeRef={intake} />);
    const receive = intake.current?.receive;
    expect(receive).toBeTypeOf("function");
    const source = document.createElement("input");
    for (const props of [
      { active: true, unavailable: "Key protection is off" },
      { active: true, busy: true },
      { active: false },
    ]) {
      view.rerender(<KeyForm {...props} save={save} intakeRef={intake} />);
      source.value = keys[0] ?? "";
      expect(receive?.(source, "anthropic")).toBe(false);
      expect(source.value).toBe("");
      expect((screen.getByLabelText("Key") as HTMLInputElement).value).toBe("");
    }
    view.rerender(<KeyForm active save={save} intakeRef={intake} />);
    fireEvent.change(screen.getByLabelText("Key ID (optional)"), { target: { value: "provider" } });
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: keys[0] } });
    fireEvent.submit(screen.getByRole("form"));
    source.value = keys[0] ?? "";
    expect(receive?.(source, "anthropic")).toBe(false);
    expect(source.value).toBe("");
    await act(async () => pending.resolve({ restart: false }));
    view.unmount();
    source.value = keys[0] ?? "";
    expect(receive?.(source, "anthropic")).toBe(false);
    expect(source.value).toBe("");
  });
});

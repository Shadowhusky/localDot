// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { ChatgptPanel } from "./ChatgptPanel.tsx";
import type { ChatgptControls } from "./useChatgpt.ts";
import { useChatgpt } from "./useChatgpt.ts";

const signedOut = () => ({
  available: true,
  codexVersion: "0.154.0",
  state: "signed_out",
  install: { state: "ready", version: "0.154.0" },
});
const signedIn = () => ({
  ...signedOut(),
  state: "signed_in",
  account: { email: "fixture@example.test", plan: "plus" },
  checkedAt: Date.now(),
  models: [{ id: "account-model", name: "Account model", isDefault: true }],
});
const material = (id = "attempt-a") => ({
  loginId: id,
  method: "code",
  userCode: id === "attempt-a" ? "TEST-CODE-A" : "TEST-CODE-B",
  verificationUrl: "https://auth.openai.com/codex/device",
  startedAt: Date.now(),
});
function fixture(initial: unknown = signedOut()) {
  const f = {
    status: initial,
    calls: [] as { method: string; path: string; body?: unknown }[],
    read: undefined as (() => Promise<Response>) | undefined,
    post: undefined as ((path: string) => Response | Promise<Response>) | undefined,
    nextLogin: material(),
  };
  const api = createApi("fixture", {
    origin: "https://fixture.test",
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname,
        method = init?.method ?? "GET";
      f.calls.push({ method, path, body: init?.body });
      if (method === "GET" && path === "/api/agent/chatgpt")
        return f.read ? f.read() : Response.json(f.status);
      if (method !== "POST") throw new Error("unexpected fixture path");
      if (f.post) return f.post(path);
      if (path.endsWith("/install")) {
        const install = { state: "downloading", receivedBytes: 1 };
        f.status = { available: true, codexVersion: "0.154.0", state: "unavailable", install };
        return Response.json(install, { status: 202 });
      }
      if (path.endsWith("/login")) {
        f.status = { ...signedOut(), state: "signing_in", login: f.nextLogin };
        return Response.json(f.nextLogin, { status: 202 });
      }
      if (path.endsWith("/refresh")) return Response.json(f.status);
      f.status = signedOut();
      return new Response(null, { status: 204 });
    },
  });
  return { api, state: f };
}
function view(f: ReturnType<typeof fixture>, initialVisible = true) {
  let current!: ChatgptControls;
  function Harness({ visible }: { visible: boolean }) {
    current = useChatgpt(f.api, visible);
    return visible ? <ChatgptPanel account={current} /> : <p>Closed</p>;
  }
  const rendered = render(<Harness visible={initialVisible} />);
  return {
    ...rendered,
    current: () => current,
    show: (visible: boolean) => rendered.rerender(<Harness visible={visible} />),
  };
}
async function opened(f: ReturnType<typeof fixture>) {
  const rendered = view(f);
  await waitFor(() => expect(rendered.current().verified).toBe(true));
  return rendered;
}
const posts = (f: ReturnType<typeof fixture>, suffix: string) =>
  f.state.calls.filter((row) => row.method === "POST" && row.path.endsWith(suffix));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("owned explicit ChatGPT setup", () => {
  it("keeps hidden and unsupported views inert and refuses login before installation", async () => {
    const f = fixture({
      available: false,
      codexVersion: "0.154.0",
      state: "unavailable",
      install: { state: "not_installed" },
    });
    const v = view(f, false);
    await act(async () => {});
    expect(f.state.calls).toEqual([]);
    act(() => v.show(true));
    await waitFor(() => expect(v.current().verified).toBe(true));
    expect(screen.queryByRole("button", { name: "Install ChatGPT support" })).toBeNull();
    await act(async () => {
      await v.current().install();
      await v.current().login();
    });
    expect(f.state.calls.every((call) => call.method === "GET")).toBe(true);
    expect(v.current().canStart).toBe(false);
  });
  it("shows the plain reason the plan is off instead of a generic line", async () => {
    const f = fixture({
      available: false,
      codexVersion: "0.154.0",
      state: "unavailable",
      install: { state: "not_installed" },
      reason: "ChatGPT plan support isn't switched on in this version yet.",
    });
    await opened(f);
    expect(
      screen.getByText("ChatGPT plan support isn't switched on in this version yet."),
    ).toBeTruthy();
    expect(screen.queryByText("ChatGPT support is unavailable on this computer.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Install ChatGPT support" })).toBeNull();
  });
  it("asks for device code sign-in in ChatGPT before offering a code", async () => {
    await opened(fixture());
    const hint = screen.getByText(
      "Turn on device code sign-in in ChatGPT under Settings → Security first.",
    );
    const button = screen.getByRole("button", { name: "Sign in with code" });
    expect(hint.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("shares one explicit installation and explicit cancellation across duplicate clicks", async () => {
    const f = fixture({
      available: true,
      codexVersion: "0.154.0",
      state: "unavailable",
      install: { state: "not_installed" },
    });
    const v = await opened(f),
      held = Promise.withResolvers<Response>();
    f.state.post = (path) => {
      if (path.endsWith("/install")) return held.promise;
      f.state.status = {
        available: true,
        codexVersion: "0.154.0",
        state: "unavailable",
        install: { state: "failed", code: "cancelled" },
      };
      return new Response(null, { status: 204 });
    };
    let first!: Promise<void>, duplicate!: Promise<void>;
    act(() => {
      first = v.current().install();
      duplicate = v.current().install();
    });
    expect(posts(f, "/install")).toHaveLength(1);
    await act(async () => {
      await v.current().cancelInstall();
      await Promise.all([first, duplicate]);
    });
    expect(posts(f, "/install/cancel")).toHaveLength(1);
    expect(v.current().summary?.install).toEqual({ state: "failed", code: "cancelled" });
    await act(async () => {
      held.resolve(Response.json({ state: "ready", version: "0.154.0" }, { status: 202 }));
      await Promise.resolve();
    });
    expect(v.current().summary?.install.state).toBe("failed");
    expect(v.current().canStart).toBe(false);
  });
  it("keeps watching an accepted installation while its first verification still reports not installed", async () => {
    const f = fixture({
      available: true,
      codexVersion: "0.154.0",
      state: "unavailable",
      install: { state: "not_installed" },
    });
    const v = await opened(f);
    f.state.post = () => Response.json({ state: "not_installed" }, { status: 202 });
    await act(async () => {
      await v.current().install();
    });
    expect(v.current().installWatching).toBe(true);
    expect(v.current().canCancelInstall).toBe(true);
    expect(screen.queryByRole("button", { name: "Install ChatGPT support" })).toBeNull();
    await act(async () => {
      await v.current().install();
    });
    expect(posts(f, "/install")).toHaveLength(1);
    f.state.status = signedOut();
    await waitFor(() => expect(v.current().summary?.install.state).toBe("ready"), {
      timeout: 2500,
    });
    expect(v.current().installWatching).toBe(false);
    expect(v.current().canCancelInstall).toBe(false);
    expect(screen.getByRole("button", { name: "Sign in with code" })).toHaveProperty(
      "disabled",
      false,
    );
    expect(posts(f, "/install")).toHaveLength(1);
  });
  it("paints device material only in the current DOM, opens/copies only on explicit action", async () => {
    const f = fixture(),
      v = await opened(f);
    const open = vi.spyOn(window, "open").mockReturnValue(null),
      writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with code" }));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe("TEST-CODE-A"),
    );
    expect(posts(f, "/login").map((row) => row.body)).toEqual(['{"method":"code"}']);
    expect(JSON.stringify(v.current().summary)).not.toMatch(/TEST-CODE-A|auth.openai.com/);
    expect(open).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open sign-in page" }));
    expect(open).toHaveBeenCalledExactlyOnceWith(
      "https://auth.openai.com/codex/device",
      "_blank",
      "noopener,noreferrer",
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("TEST-CODE-A"));
    const code = screen.getByLabelText<HTMLInputElement>("Sign-in code"),
      url = screen.getByLabelText<HTMLInputElement>("Sign-in page");
    act(() => v.show(false));
    expect(code.value).toBe("");
    expect(url.value).toBe("");
    expect(posts(f, "/login/cancel")).toHaveLength(0);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
  it("does not repaint a late sign-in reply after closure and reads the real signed-in account on reopening", async () => {
    const f = fixture(),
      v = await opened(f),
      held = Promise.withResolvers<Response>();
    f.state.post = () => held.promise;
    let login!: Promise<void>;
    act(() => {
      login = v.current().login();
    });
    act(() => v.show(false));
    await act(async () => {
      f.state.status = signedIn();
      held.resolve(Response.json(material(), { status: 202 }));
      await login;
    });
    expect(v.current().summary?.state).toBe("signed_out");
    expect(posts(f, "/login/cancel")).toHaveLength(0);
    act(() => v.show(true));
    await waitFor(() => expect(v.current().summary?.state).toBe("signed_in"));
    expect(v.current().canStart).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe("");
  });
  it("ignores an older poll after Cancel and a different sign-in attempt", async () => {
    const f = fixture(),
      v = await opened(f);
    await act(async () => {
      await v.current().login();
    });
    const held = Promise.withResolvers<Response>();
    let readCount = 0;
    f.state.read = async () => (++readCount === 1 ? held.promise : Response.json(f.state.status));
    let old!: Promise<void>;
    act(() => {
      old = v.current().check();
    });
    await act(async () => {
      await v.current().cancelLogin();
      await old;
    });
    f.state.nextLogin = material("attempt-b");
    await act(async () => {
      await v.current().login();
    });
    expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe("TEST-CODE-B");
    await act(async () => {
      held.resolve(Response.json({ ...signedOut(), state: "signing_in", login: material() }));
      await Promise.resolve();
    });
    expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe("TEST-CODE-B");
    expect(v.current().summary?.login?.loginId).toBe("attempt-b");
  });
  it("rejects a different login identity returned by an unsolicited cached poll", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      v = view(f);
    await act(async () => {});
    await act(async () => {
      await v.current().login();
    });
    f.state.status = { ...signedOut(), state: "signing_in", login: material("attempt-b") };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe("");
    expect(v.current().summary?.login?.loginId).toBe("attempt-a");
    expect(v.current().verified).toBe(false);
    expect(v.current().canStart).toBe(false);
  });
  it("Cancel rereads actual account state and can discover already-completed sign-in", async () => {
    const f = fixture(),
      v = await opened(f);
    await act(async () => {
      await v.current().login();
    });
    f.state.post = () => {
      f.state.status = signedIn();
      return new Response(null, { status: 204 });
    };
    await act(async () => {
      await v.current().cancelLogin();
    });
    expect(v.current().summary?.state).toBe("signed_in");
    expect(v.current().canStart).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe("");
  });
  it("requires the account-change confirmation and keeps launch blocked after a retirement failure", async () => {
    const f = fixture(signedIn()),
      v = await opened(f);
    expect(v.current().canStart).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh account" }));
    expect(posts(f, "/refresh")).toHaveLength(0);
    expect(screen.getByRole("alertdialog").textContent).toContain("pauses current ChatGPT work");
    f.state.post = () => {
      f.state.status = {
        available: false,
        codexVersion: "0.154.0",
        state: "unavailable",
        install: { state: "ready", version: "0.154.0" },
      };
      return new Response("TEST-PRIVATE-RETIREMENT", { status: 503 });
    };
    fireEvent.click(screen.getByRole("button", { name: "Pause work and refresh" }));
    await waitFor(() => expect(v.current().uncertain).toBe(true));
    expect(v.current().canStart).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("blocked");
    expect(document.body.textContent).not.toContain("TEST-PRIVATE-RETIREMENT");
    await act(async () => {
      await v.current().check();
    });
    expect(v.current().canStart).toBe(false);
    expect(v.current().summary?.available).toBe(false);
  });
  it("polls only a visible ongoing sign-in and clears material on offline/hide", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T02:00:00Z"));
    const f = fixture(),
      v = view(f);
    await act(async () => {});
    await act(async () => {
      await v.current().login();
    });
    const before = f.state.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(f.state.calls.length).toBe(before + 1);
    const code = screen.getByLabelText<HTMLInputElement>("Sign-in code");
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(code.value).toBe("");
    expect(v.current().canStart).toBe(false);
    const stopped = f.state.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(f.state.calls).toHaveLength(stopped);
    act(() => v.show(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(f.state.calls).toHaveLength(stopped);
    expect(posts(f, "/login/cancel")).toHaveLength(0);
  });
  it("ends the transient login panel at ten minutes without assuming daemon cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T02:00:00Z"));
    const f = fixture(),
      v = view(f);
    await act(async () => {});
    await act(async () => {
      await v.current().login();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600001);
    });
    expect(v.current().expired).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe("");
    expect(posts(f, "/login/cancel")).toHaveLength(0);
    const stopped = f.state.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(f.state.calls).toHaveLength(stopped);
  });
  it("does not poll a terminal installed account or start a browser/paid fallback", async () => {
    vi.useFakeTimers();
    const f = fixture(signedIn()),
      v = view(f);
    await act(async () => {});
    expect(v.current().canStart).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(f.state.calls).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /browser|API/i })).toBeNull();
    expect(screen.getByText(/Primary window: Unknown/)).toBeTruthy();
    expect(screen.getByText(/Secondary window: Unknown/)).toBeTruthy();
  });
  it.each(["copy", "open"])(
    "checks the sign-in deadline again at explicit %s time",
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
      const f = fixture(),
        v = view(f);
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      await act(async () => {});
      await act(async () => {
        await v.current().login();
      });
      const code = screen.getByLabelText<HTMLInputElement>("Sign-in code");
      const url = screen.getByLabelText<HTMLInputElement>("Sign-in page");
      expect(code.value).toBe("TEST-CODE-A");
      // Advance wall time without delivering timers: an explicit action must independently
      // enforce expiry even if the browser has deferred the material-expiry callback.
      vi.setSystemTime(Date.now() + 600001);
      await act(async () => {
        if (action === "copy") await v.current().copyCode();
        else v.current().openPage();
      });
      expect(code.value).toBe("");
      expect(url.value).toBe("");
      expect(open).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
      expect(posts(f, "/login/cancel")).toHaveLength(0);
    },
  );
  it("keeps installation retry closed when acknowledged Cancel has no verified reread", async () => {
    const f = fixture({
      available: true,
      codexVersion: "0.154.0",
      state: "unavailable",
      install: { state: "not_installed" },
    });
    const v = await opened(f);
    f.state.post = (path) => {
      if (path.endsWith("/install/cancel")) return new Response(null, { status: 204 });
      throw new Error("inert uncertain request");
    };
    await act(async () => {
      await v.current().install();
    });
    f.state.read = async () => {
      throw new Error("inert failed verification");
    };
    await act(async () => {
      await v.current().cancelInstall();
    });
    expect(v.current().installWatching).toBe(true);
    expect(v.current().verified).toBe(false);
    const before = posts(f, "/install").length;
    await act(async () => {
      await v.current().install();
    });
    expect(posts(f, "/install")).toHaveLength(before);
  });
});

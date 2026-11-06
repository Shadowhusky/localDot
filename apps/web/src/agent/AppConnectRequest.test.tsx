// @vitest-environment jsdom

import type { ConnectorView, QuestionAnswerRequest } from "@localdot/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { AskForm } from "./AskForm.tsx";
import { AskDraft } from "./ask-draft.ts";

const askId = "01JXYZ00000000000000000001";

function appView(change: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: "linear",
    name: "Linear",
    enabled: true,
    server: {
      kind: "remote",
      url: "https://mcp.linear.app/mcp",
      transport: "http",
      auth: { kind: "oauth" },
    },
    status: "needs_sign_in",
    tools: [],
    createdAt: 1,
    ...change,
  };
}

const connected = appView({
  status: "ready",
  server: {
    kind: "remote",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    auth: { kind: "oauth", secret: "connector-linear" },
  },
});
const waiting = appView({ signIn: { expiresAt: 1e15, remote: false } });

function setup(
  started: Record<string, unknown> | Error = { opened: true, expiresAt: 1, remote: false },
) {
  const views = { current: appView() };
  const post = vi.fn(async () => {
    if (started instanceof Error) throw started;
    views.current = waiting;
    return started;
  });
  const del = vi.fn(async () => {});
  const api = {
    post,
    del,
    get: vi.fn(async () => ({ connectors: [views.current], catalog: [] })),
  } as unknown as ApiClient;
  const draft = new AskDraft({
    askId,
    question: "Connect Linear?",
    options: [],
    allowText: false,
    fields: [
      {
        id: "app",
        kind: "connect_app",
        label: "Linear",
        connect: { connector: "linear", name: "Linear", host: "mcp.linear.app" },
      },
    ],
  });
  const answer = vi.fn(async (_request: QuestionAnswerRequest) => true);
  const mount = () =>
    render(<AskForm draft={draft} layout="thread" answer={answer} connectApi={api} />);
  const connect = () =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    });
  const poll = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
  return { views, post, del, answer, connect, poll, mount };
}

const fixture = async (started?: Record<string, unknown> | Error) => {
  const f = setup(started);
  await act(async () => {
    f.mount();
    await vi.advanceTimersByTimeAsync(0);
  });
  return f;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("names the app and where it signs in, then answers by itself once it is connected", async () => {
  const f = await fixture();
  expect(screen.getByText("Linear")).toBeTruthy();
  expect(screen.getByText("mcp.linear.app")).toBeTruthy();
  await f.connect();
  expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/connectors/linear/sign-in");
  expect(screen.getByText(/Approve Linear in your browser/)).toBeTruthy();
  await f.poll();
  expect(f.answer).not.toHaveBeenCalled();
  f.views.current = connected;
  await f.poll();
  expect(f.answer).toHaveBeenCalledExactlyOnceWith({ askId, fields: { app: true } });
});

it("says plainly from another device that it can't be finished there", async () => {
  const f = await fixture({ opened: true, expiresAt: 1, remote: true });
  await f.connect();
  expect(screen.getByText(/It can't be finished from this device/)).toBeTruthy();
  expect(screen.getByText(/browser on your Mac/)).toBeTruthy();
});

it("gives this browser the page's address when none could be opened", async () => {
  const url = "https://auth.linear.example/authorize?state=abc";
  const f = await fixture({ opened: false, url, expiresAt: 1, remote: false });
  await f.connect();
  const link = screen.getByRole("link", { name: "Open the sign-in page" }) as HTMLAnchorElement;
  expect(link.href).toBe(url);
  expect(link.rel).toContain("noopener");
});

it("stops waiting when the sign-in ends without connecting, and says why", async () => {
  const f = await fixture();
  await f.connect();
  f.views.current = appView({ problem: "The sign-in wasn't approved. Try again." });
  await f.poll();
  expect(screen.getByRole("alert").textContent).toContain("wasn't approved");
  expect(f.answer).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

it("shows why the sign-in couldn't be opened", async () => {
  const body = JSON.stringify({ message: "This app only signs in with apps registered with it." });
  const f = await fixture(new ApiError(400, body));
  await f.connect();
  expect(screen.getByRole("alert").textContent).toContain("registered with it");
});

it("picks up a sign-in already under way, and can open the page again", async () => {
  const f = setup();
  f.views.current = waiting;
  await act(async () => {
    f.mount();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText(/Approve Linear in your browser/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open again" }));
  });
  expect(f.post).toHaveBeenCalledExactlyOnceWith("/api/connectors/linear/sign-in");
});

it("cancels the sign-in it opened when the user says Not now", async () => {
  const f = await fixture();
  await f.connect();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  });
  expect(f.del).toHaveBeenCalledExactlyOnceWith("/api/connectors/linear/sign-in");
  expect(f.answer).toHaveBeenCalledExactlyOnceWith({ askId, declined: true });
});

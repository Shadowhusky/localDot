// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReportBundle } from "../../../../packages/protocol/src/reports.ts";
import { type ApiClient, ApiError } from "../lib/api.ts";
import { ReportProblem } from "./ReportProblem.tsx";
import type { ReportControl } from "./reports-api.ts";

afterEach(cleanup);
const SESSION = "01M5W3F2P1NMZC9DZ9JP761JXD";
const DRAFT = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";
const bundle: ReportBundle = {
  format: 1,
  createdAt: "2026-10-29T08:00:00.000Z",
  installId: "0123456789abcdef0123456789abcdef",
  source: "app",
  summary: "Task: the brain kept crashing",
  message: "It stopped while booking",
  context: { kind: "task", sessionId: SESSION, reason: "the brain kept crashing" },
  app: { version: "1.4.0", channel: "stable", install: "managed", state: "running" },
  host: {
    os: "darwin",
    arch: "arm64",
    release: "25.6.0",
    node: "v24.11.0",
    cpus: 10,
    memoryGB: 32,
  },
  services: { keyd: "ready", docker: "running" },
  doctor: [
    { name: "docker-engine", ok: true, detail: "Docker Engine 29.2.0" },
    { name: "image-desktop", ok: false, detail: "missing" },
  ],
  computers: [],
  tasks: [],
  logs: [{ name: "logs/daemon.log", lines: ["started"], truncated: false }],
};

function fixture(options: { enabled?: boolean; send?: () => Response } = {}) {
  const requests: { path: string; body: unknown }[] = [];
  const api = {
    get: vi.fn(async (path: string) =>
      path === "/api/reports"
        ? {
            enabled: options.enabled ?? true,
            sent: [{ id: "LD-AAAA-BBBB", sentAt: "2026-10-20T08:00:00.000Z", summary: "Older" }],
          }
        : {
            id: "LD-AAAA-BBBB",
            status: "investigating",
            receivedAt: "2026-10-20T08:00:00.000Z",
            updatedAt: "2026-10-21T08:00:00.000Z",
          },
    ),
    put: vi.fn(async (_path: string, body: { enabled: boolean }) => ({
      enabled: body.enabled,
      sent: [],
    })),
    del: vi.fn(async () => {}),
    authorization: () => "Bearer t",
    socketUrl: (path: string) => `ws://127.0.0.1:4750${path}`,
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/api/reports/drafts")
        return Response.json({ draft: DRAFT, bundle, bytes: 2048 });
      return (
        options.send?.() ??
        Response.json({
          id: "LD-7K3P-Q9XA",
          sentAt: "2026-10-29T09:00:00.000Z",
          summary: bundle.summary,
        })
      );
    }),
  };
  const report: ReportControl = {
    api: api as unknown as ApiClient,
    about: {
      context: { kind: "task", sessionId: SESSION, reason: "the brain kept crashing" },
      title: "The task ended: the brain kept crashing",
    },
    start: vi.fn(),
    clear: vi.fn(),
  };
  render(<ReportProblem report={report} />);
  return { api, report, requests };
}

it("shows everything a report holds before it is sent, then the ID to quote", async () => {
  const f = fixture();
  expect(await screen.findByText("The task ended: the brain kept crashing")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "What happened?" }), {
    target: { value: "  It stopped while booking  " },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Include what you asked dot to do" }));
  fireEvent.click(screen.getByRole("button", { name: "Review report" }));
  expect(await screen.findByText("What will be sent")).toBeTruthy();
  expect(f.requests[0]).toEqual({
    path: "/api/reports/drafts",
    body: {
      source: "app",
      message: "It stopped while booking",
      context: { kind: "task", sessionId: SESSION, reason: "the brain kept crashing" },
      includeRequest: true,
    },
  });
  expect(screen.getByText("1 of 2 failed")).toBeTruthy();
  expect(screen.getByText("2.0 KB compressed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Everything that will be sent" }));
  expect(screen.getByText(/"installId": "0123456789abcdef0123456789abcdef"/)).toBeTruthy();
  expect(f.requests).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  expect(await screen.findByText("Report sent. Quote this ID when you ask for help.")).toBeTruthy();
  expect(f.requests[1]?.path).toBe(`/api/reports/drafts/${DRAFT}/send`);
  expect(f.report.clear).toHaveBeenCalled();
  expect(screen.getAllByText(/LD-7K3P-Q9XA|LD-AAAA-BBBB/)).toHaveLength(3);
});

it("keeps the reviewed report when sending fails, with the service's reason", async () => {
  fixture({
    send: () =>
      new Response("Too many reports from this computer. Try again in an hour.", { status: 502 }),
  });
  fireEvent.click(await screen.findByRole("button", { name: "Review report" }));
  fireEvent.click(await screen.findByRole("button", { name: "Send report" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Too many reports from this computer. Try again in an hour.",
  );
  expect(screen.getByRole("button", { name: "Send report" })).toBeTruthy();
});

it("follows and deletes a sent report, and turns reporting off", async () => {
  const f = fixture();
  expect(await screen.findByText("Being looked at")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete LD-AAAA-BBBB" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete report" }));
  await waitFor(() => expect(f.api.del).toHaveBeenCalledWith("/api/reports/sent/LD-AAAA-BBBB"));
  await waitFor(() => expect(screen.queryByText("LD-AAAA-BBBB")).toBeNull());
  fireEvent.click(screen.getByRole("switch", { name: "Allow problem reports" }));
  await waitFor(() => expect(f.api.put).toHaveBeenCalledWith("/api/reports", { enabled: false }));
  expect(await screen.findByText(/Problem reports are off/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review report" })).toBeNull();
});

it("says when a sent report is no longer kept", async () => {
  const f = fixture();
  f.api.get.mockImplementation(async (path: string) => {
    if (path === "/api/reports")
      return {
        enabled: true,
        sent: [{ id: "LD-AAAA-BBBB", sentAt: "2026-10-20T08:00:00.000Z", summary: "s" }],
      };
    throw new ApiError(404, "gone");
  });
  cleanup();
  render(<ReportProblem report={f.report} />);
  expect(await screen.findByText("No longer kept")).toBeTruthy();
});

// @vitest-environment jsdom
import type { ComputerSizeView } from "@localdot/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api.ts";
import { SizeRow } from "../onboarding/steps.tsx";
import { ComputerSizeSettings } from "./ComputerSize.tsx";
import { cpuSlider, dockerTip, memorySlider, recommendedSize } from "./computer-size.ts";

const GIB = 1024 ** 3;

afterEach(cleanup);

function viewOf(change: Partial<ComputerSizeView> = {}): ComputerSizeView {
  return {
    size: { memoryBytes: 4 * GIB, cpus: 4 },
    default: { memoryBytes: 4 * GIB, cpus: 4 },
    min: { memoryBytes: 2 * GIB, cpus: 2 },
    max: { memoryBytes: 5.5 * GIB, cpus: 24 },
    docker: { memoryBytes: 7.6 * GIB, cpus: 24, app: "docker-desktop" },
    others: { memoryBytes: 0, cpus: 0 },
    headroomBytes: 2 * GIB,
    usage: { memoryBytes: 0.95 * GIB, cpus: 0.42 },
    pending: false,
    ...change,
  };
}

describe("the computer's size, worked out for the page", () => {
  it("recommends today's size, or what Docker can hold of it, or nothing when it can't", () => {
    expect(recommendedSize(viewOf())).toEqual({ memoryBytes: 4 * GIB, cpus: 4 });
    expect(recommendedSize(viewOf({ max: { memoryBytes: 3 * GIB, cpus: 3 } }))).toEqual({
      memoryBytes: 3 * GIB,
      cpus: 3,
    });
    expect(recommendedSize(viewOf({ max: { memoryBytes: 1.5 * GIB, cpus: 24 } }))).toBeNull();
    expect(recommendedSize(viewOf({ max: { memoryBytes: 4 * GIB, cpus: 1 } }))).toBeNull();
  });

  it("says where Docker's limit is raised, in the words of the app that runs it", () => {
    const docker = viewOf().docker;
    expect(dockerTip(docker, "memory")).toBe(
      "Docker gives localDot 7.6 GB. Raise it in Docker Desktop → Settings → Resources.",
    );
    expect(dockerTip(docker, "cpus")).toBe(
      "Docker gives localDot 24 CPUs. Raise it in Docker Desktop → Settings → Resources.",
    );
    expect(dockerTip({ ...docker, app: "orbstack" }, "memory")).toBe(
      "Docker gives localDot 7.6 GB. Raise it in OrbStack → Settings → System.",
    );
    expect(dockerTip({ ...docker, app: "vm" }, "cpus")).toBe(
      "Docker gives localDot 24 CPUs. Raise it in the settings of the app that runs Docker.",
    );
    expect(dockerTip({ ...docker, app: "host" }, "memory")).toBe(
      "Docker gives localDot all 7.6 GB of this computer's memory.",
    );
    expect(dockerTip({ ...docker, app: "host" }, "cpus")).toBe(
      "Docker gives localDot all 24 of this computer's CPUs.",
    );
  });

  it("lays Docker's memory along the track: in use, other dots, kept free", () => {
    const view = viewOf({
      docker: { memoryBytes: 16 * GIB, cpus: 24, app: "docker-desktop" },
      others: { memoryBytes: 4 * GIB, cpus: 4 },
      max: { memoryBytes: 10 * GIB, cpus: 20 },
    });
    const memory = memorySlider(view, 6 * GIB);
    expect(memory).toMatchObject({ value: 6, min: 2, max: 10, end: 16, step: 0.5 });
    expect(memory.marks).toEqual([
      { from: 0, to: 0.95, tone: "used" },
      { from: 10, to: 14, tone: "held" },
      { from: 14, to: 16, tone: "kept" },
    ]);
    expect(memory.legend.map((key) => key.text)).toEqual([
      "0.9 GB in use",
      "Other dots hold 4 GB",
      "2 GB kept free",
    ]);
    const cpus = cpuSlider(view, 6);
    expect(cpus).toMatchObject({ value: 6, min: 2, max: 20, end: 24, step: 1 });
    expect(cpus.marks).toEqual([
      { from: 0, to: 0.42, tone: "used" },
      { from: 20, to: 24, tone: "held" },
    ]);
  });

  it("lets a size Docker can no longer hold be kept, and never offers more", () => {
    const view = viewOf({ size: { memoryBytes: 6 * GIB, cpus: 4 } });
    expect(memorySlider(view, 6 * GIB).max).toBe(6);
    expect(memorySlider(viewOf(), 4 * GIB).max).toBe(5.5);
  });
});

function api(views: ComputerSizeView[], saved: unknown[] = []) {
  return createApi("fixture", {
    origin: "http://127.0.0.1:4790",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe("/api/computer-size");
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        saved.push(body);
        return Response.json(viewOf({ size: body }));
      }
      return Response.json(views.shift() ?? viewOf());
    }) as typeof fetch,
  });
}

describe("Settings › Your computer", () => {
  it("shows both sliders with what Docker has, and saves a change once the keys pause", async () => {
    const saved: unknown[] = [];
    render(<ComputerSizeSettings api={api([viewOf()], saved)} />);
    const memory = await screen.findByRole("slider", { name: "Memory" });
    expect(memory.getAttribute("aria-valuetext")).toBe("4 GB");
    expect(screen.getByRole("slider", { name: "CPUs" }).getAttribute("aria-valuetext")).toBe(
      "4 CPUs",
    );
    expect(screen.getByRole("button", { name: "Memory limit: 7.6 GB" })).toBeTruthy();
    expect(screen.getByText("0.9 GB in use")).toBeTruthy();
    expect(screen.getByText("2 GB kept free")).toBeTruthy();
    fireEvent.keyDown(memory, { key: "ArrowRight" });
    fireEvent.keyDown(memory, { key: "ArrowRight" });
    expect(memory.getAttribute("aria-valuetext")).toBe("5 GB");
    expect(screen.getByRole("status").textContent).toContain(
      "The web browser runs beside the desktop with 3.8 GB and 2 CPUs of its own.",
    );
    expect(saved).toEqual([]);
    await waitFor(() => expect(saved).toEqual([{ memoryBytes: 5 * GIB, cpus: 4 }]));
  });

  it("says when the smaller size waits for the next start", async () => {
    render(<ComputerSizeSettings api={api([viewOf({ pending: true })])} />);
    expect(
      await screen.findByText(
        "Saved. The computer is using more memory than that right now, so the smaller size applies when it next starts.",
      ),
    ).toBeTruthy();
  });

  it("says so when Docker isn't answering", async () => {
    const down = createApi("fixture", {
      origin: "http://127.0.0.1:4790",
      fetchImpl: (async () =>
        new Response("Docker isn't answering", { status: 503 })) as typeof fetch,
    });
    render(<ComputerSizeSettings api={down} />);
    expect(
      await screen.findByText("Docker isn't answering, so the computer's size can't be shown now."),
    ).toBeTruthy();
  });
});

describe("setup's computer size", () => {
  it("shows the recommended size and opens the sliders in place", () => {
    const onChange = vi.fn();
    const view = viewOf({
      size: { memoryBytes: 3 * GIB, cpus: 4 },
      max: { memoryBytes: 3 * GIB, cpus: 24 },
    });
    render(
      <SizeRow
        choice={{
          view,
          size: { memoryBytes: 3 * GIB, cpus: 4 },
          recommended: { memoryBytes: 3 * GIB, cpus: 4 },
          onChange,
        }}
      />,
    );
    expect(screen.getByText("3 GB · 4 CPUs")).toBeTruthy();
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change computer size" }));
    const memory = screen.getByRole("slider", { name: "Memory" });
    fireEvent.keyDown(memory, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector(".ui-step-slider-reason")?.textContent).toBe(
      "That's all Docker can hold for it: 2 GB stays free for the web browser and Docker.",
    );
    fireEvent.keyDown(memory, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith({ memoryBytes: 2.5 * GIB, cpus: 4 });
  });

  it("says plainly when Docker can't hold even the smallest computer", () => {
    const view = viewOf({ max: { memoryBytes: 1.5 * GIB, cpus: 24 } });
    render(<SizeRow choice={{ view, size: view.size, recommended: null, onChange: vi.fn() }} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Docker can't hold dot's computer beside what else runs: it needs at least 2 GB. Docker gives localDot 7.6 GB. Raise it in Docker Desktop → Settings → Resources.",
    );
    expect(screen.queryByRole("button", { name: "Change computer size" })).toBeNull();
  });
});

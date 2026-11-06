// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserEngineStatus } from "../../../../packages/protocol/src/browser-engine.ts";
import type { ApiClient } from "../lib/api.ts";
import { BrowserEngineSettings } from "./BrowserEngineSettings.tsx";
import { type BrowserEngineView, useBrowserEngine } from "./useBrowserEngine.ts";

afterEach(cleanup);

const STATUS: BrowserEngineStatus = {
  engine: "chromium",
  version: "154.0.8037.57",
  choice: null,
  offered: true,
  builtIn: false,
  installing: false,
  restartNeeded: false,
};

function view(status: Partial<BrowserEngineStatus>, more: Partial<BrowserEngineView> = {}) {
  return {
    status: { ...STATUS, ...status },
    pending: null,
    failure: null,
    choose: vi.fn(async () => true),
    restoreBackup: vi.fn(),
    deleteBackup: vi.fn(),
    ...more,
  } satisfies BrowserEngineView;
}

describe("the web browser setting", () => {
  it("asks before installing Chrome, naming Google and linking its terms", () => {
    const engine = view({});
    render(<BrowserEngineSettings view={engine} />);
    expect(screen.getByText(/Chromium 154/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use Google Chrome…" }));
    expect(engine.choose).not.toHaveBeenCalled();
    expect(screen.getByText(/comes from Google, not localDot/u)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Google's Terms of Service" }).getAttribute("href"),
    ).toBe("https://policies.google.com/terms");
    expect(
      screen.getByRole("link", { name: "Chrome's Additional Terms" }).getAttribute("href"),
    ).toBe("https://www.google.com/chrome/terms/");
    fireEvent.click(screen.getByRole("button", { name: "Accept and install" }));
    expect(engine.choose).toHaveBeenCalledWith({
      choice: "chrome",
      acceptGoogleTerms: true,
      restart: true,
    });
  });

  it("says why Chromium is in use when Chrome couldn't be installed, and offers another try", () => {
    render(
      <BrowserEngineSettings
        view={view({ choice: "chrome", problem: "Google's signing key didn't match." })}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Using Chromium. Google's signing key didn't match.",
    );
    expect(screen.getByRole("button", { name: "Try again…" })).toBeTruthy();
  });

  it("offers nothing where Chrome can't be added", () => {
    render(<BrowserEngineSettings view={view({ offered: false })} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names a build that has Chrome in it", () => {
    render(
      <BrowserEngineSettings
        view={view({ engine: "chrome", version: "156.0.1.1", builtIn: true, offered: false })}
      />,
    );
    expect(screen.getByText("Google Chrome 156, built into this version")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("gives a way back to the backup, warning what is lost, and only after asking", () => {
    const engine = view({
      engine: "chrome",
      version: "157.0.1.1",
      choice: "chrome",
      backup: { at: "2026-11-01T10:00:00.000Z", version: "154.0.8037.57" },
    });
    render(<BrowserEngineSettings view={engine} />);
    fireEvent.click(screen.getByRole("button", { name: "Go back to Chromium…" }));
    expect(engine.restoreBackup).not.toHaveBeenCalled();
    expect(screen.getByText(/signed in to or saved since then is lost/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(engine.restoreBackup).toHaveBeenCalledOnce();
  });

  it("shows the daemon's reason when it refuses a change", () => {
    render(
      <BrowserEngineSettings
        view={view(
          { engine: "chrome", choice: "chrome" },
          { failure: "Sign out of all sites first." },
        )}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Sign out of all sites first.");
  });
});

describe("reading the choice from the daemon", () => {
  const daemon = () => {
    let status = STATUS;
    const get = vi.fn(async () => status);
    const put = vi.fn(async () => {
      status = { ...STATUS, installing: true };
      return status;
    });
    return { put, api: { get, put } as unknown as ApiClient };
  };

  it("reads while visible and sends the acceptance with the choice", async () => {
    const fake = daemon();
    const seen: BrowserEngineView[] = [];
    function Probe() {
      seen.push(useBrowserEngine(fake.api, true));
      return null;
    }
    render(<Probe />);
    await waitFor(() => expect(seen.at(-1)?.status?.engine).toBe("chromium"));
    expect(await seen.at(-1)?.choose({ choice: "chrome", acceptGoogleTerms: true })).toBe(true);
    expect(fake.put).toHaveBeenCalledWith("/api/browser/engine", {
      choice: "chrome",
      acceptGoogleTerms: true,
    });
    await waitFor(() => expect(seen.at(-1)?.status?.installing).toBe(true));
  });
});

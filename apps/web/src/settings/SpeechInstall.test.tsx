// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechInstallStatus } from "../../../../packages/protocol/src/speech-install.ts";
import { SpeechStep } from "../onboarding/steps.tsx";
import type { SpeechInstallControl } from "../voice/useSpeechInstall.ts";
import { SpeechInstallPanel } from "./SpeechInstall.tsx";

afterEach(cleanup);

const MB = 1024 ** 2;
const tier = (id: "light" | "balanced" | "languages", over = {}) => ({
  id,
  name: { light: "Light", balanced: "Balanced", languages: "Most languages" }[id],
  summary: `${id} summary`,
  credit: `${id} credit`,
  languages: ["zh", "en"],
  downloadBytes: 150 * MB,
  diskBytes: 200 * MB,
  memoryBytes: 500 * MB,
  speed: "About a second for a short message",
  ...over,
});

const STATUS: SpeechInstallStatus = {
  supported: true,
  host: { computer: "Mac", memoryBytes: 8 * 1024 * MB, cpus: 8, arch: "arm64" },
  tiers: [
    tier("light"),
    tier("balanced"),
    tier("languages", {
      languages: null,
      warning: "Will be slow on this computer: long messages can take a minute.",
    }),
  ],
  recommended: "balanced",
  installed: null,
  handInstalled: null,
  using: null,
  job: null,
  freeBytes: 40 * 1024 * MB,
};

function control(status: Partial<SpeechInstallStatus> = {}, over = {}): SpeechInstallControl {
  return {
    status: { ...STATUS, ...status },
    pending: null,
    failure: null,
    install: vi.fn(async () => true),
    cancel: vi.fn(),
    remove: vi.fn(),
    ...over,
  };
}

const panel = (speech: SpeechInstallControl, language = "zh-CN") =>
  render(<SpeechInstallPanel speech={speech} language={language} />);

describe("Settings › Voice › speech model", () => {
  it("offers the tiers with the recommended one chosen, and installs only on a press", () => {
    const speech = control();
    panel(speech);
    const group = screen.getByRole("radiogroup", { name: "Speech model" });
    const balanced = within(group).getByRole("radio", { name: /^Balanced/ }) as HTMLInputElement;
    expect(balanced.checked).toBe(true);
    expect(balanced.closest("label")?.textContent).toContain("Recommended");
    expect(speech.install).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("radio", { name: /^Light/ }));
    expect(speech.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Install Light/ }));
    expect(speech.install).toHaveBeenCalledWith("light");
  });

  it("gives size, memory and speed in plain words, and warns honestly", () => {
    panel(control());
    const light = screen.getByRole("radio", { name: /^Light/ }).closest("label")?.textContent;
    expect(light).toContain("150 MB download");
    expect(light).toContain("500 MB of memory");
    expect(light).toContain("About a second");
    const best = screen.getByRole("radio", { name: /^Most languages/ }) as HTMLInputElement;
    expect(best.closest("label")?.textContent).toContain("Will be slow on this computer");
    expect(best.disabled).toBe(false);
  });

  it("chooses a tier that hears the person's language, and says when one doesn't", () => {
    panel(control(), "ja-JP");
    expect(
      (screen.getByRole("radio", { name: /^Most languages/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByRole("radio", { name: /^Light/ }).closest("label")?.textContent).toContain(
      "Doesn't hear the language you chose",
    );
  });

  it("shows the stages and real numbers, and can be cancelled", () => {
    const speech = control({
      job: {
        tier: "balanced",
        state: "running",
        stage: "model",
        doneBytes: 45 * MB,
        totalBytes: 150 * MB,
      },
    });
    panel(speech);
    expect(screen.getByText("Installing Balanced on your Mac…")).toBeTruthy();
    expect(screen.getByText("45 MB of 150 MB")).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Install steps" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(String(45 * MB));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(speech.cancel).toHaveBeenCalledTimes(1);
  });

  it("says why it stopped and offers Retry", () => {
    const speech = control({
      job: {
        tier: "balanced",
        state: "failed",
        stage: "model",
        doneBytes: 45 * MB,
        totalBytes: 150 * MB,
        problem: "network",
        message: "The speech model couldn't be downloaded. Check your connection, then Retry.",
      },
    });
    panel(speech);
    expect(screen.getByRole("alert").textContent).toMatch(/Check your connection/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(speech.install).toHaveBeenCalledWith("balanced");
  });

  it("shows what's installed, and removes only after asking", () => {
    const speech = control({
      installed: { tier: "balanced", name: "Balanced", diskBytes: 210 * MB, damaged: false },
      using: "installed",
    });
    panel(speech);
    expect(screen.getByText(/Installed by localDot · 210 MB/)).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(speech.remove).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(speech.remove).toHaveBeenCalledTimes(1);
  });

  it("says when the installed model doesn't hear the chosen language", () => {
    panel(
      control({
        installed: { tier: "balanced", name: "Balanced", diskBytes: 210 * MB, damaged: false },
        using: "installed",
      }),
      "ja-JP",
    );
    expect(screen.getByText(/Doesn't hear the language you chose/)).toBeTruthy();
  });

  it("offers to reinstall damaged files rather than running them", () => {
    panel(
      control({
        installed: { tier: "balanced", name: "Balanced", diskBytes: 210 * MB, damaged: true },
      }),
    );
    expect(screen.getByText(/won't run them/)).toBeTruthy();
    expect(screen.getByRole("radiogroup")).toBeTruthy();
  });

  it("shows a hand-installed Whisper as such, and gives no way to remove it", () => {
    panel(
      control({
        handInstalled: { model: "ggml-base.bin", englishOnly: false },
        using: "hand-installed",
      }),
    );
    expect(screen.getByText("Your own Whisper")).toBeTruthy();
    expect(screen.getByText(/ggml-base\.bin/)).toBeTruthy();
    expect(screen.getByText(/never changes or removes it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    // A better model can still be installed beside it.
    expect(screen.getByRole("radiogroup")).toBeTruthy();
  });

  it("says when this system has no speech program", () => {
    panel(control({ supported: false }));
    expect(screen.getByText("Not available here")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("calls a computer that isn't a Mac what it is", () => {
    panel(control({ host: { ...STATUS.host, computer: "computer" } }));
    expect(screen.getByText("Speech model on your computer")).toBeTruthy();
    expect(screen.queryByText(/your Mac/)).toBeNull();
  });
});

describe("setup › Talk to dot", () => {
  const step = (speech: SpeechInstallControl, phone = false) =>
    render(
      <SpeechStep
        speech={speech}
        status={speech.status as SpeechInstallStatus}
        tier="balanced"
        onTier={vi.fn()}
        language="zh-CN"
        phone={phone}
      />,
    );

  it("preselects the tier and downloads nothing by itself", () => {
    const speech = control();
    step(speech);
    expect((screen.getByRole("radio", { name: /^Balanced/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(speech.install).not.toHaveBeenCalled();
    expect(screen.getByText(/setup won't wait/)).toBeTruthy();
  });

  it("tells someone on a phone that the Mac does the download", () => {
    step(control(), true);
    expect(screen.getByText(/Your Mac does the download, not this phone/)).toBeTruthy();
  });

  it("shows a download under way, which setup doesn't wait for", () => {
    step(
      control({
        job: {
          tier: "balanced",
          state: "running",
          stage: "program",
          doneBytes: 5 * MB,
          totalBytes: 150 * MB,
        },
      }),
    );
    expect(screen.getByText(/Setup doesn't need to wait/)).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });
});

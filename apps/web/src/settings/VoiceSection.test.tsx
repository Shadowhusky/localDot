// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE } from "../voice/prefs.ts";
import { type VoiceControl, VoiceSection } from "./VoiceSection.tsx";

afterEach(cleanup);

function control(over: Partial<VoiceControl> = {}): VoiceControl {
  return {
    prefs: DEFAULT_VOICE,
    saved: true,
    change: vi.fn(),
    route: { kind: "device" },
    browser: ["ja-JP"],
    downloading: false,
    download: vi.fn(),
    ...over,
  };
}

describe("Settings › Voice", () => {
  it("says where speech becomes text, and keeps both extras off by default", () => {
    render(<VoiceSection voice={control()} />);
    expect(screen.getByText("On this device")).toBeTruthy();
    expect(
      screen.getByText("Your browser turns speech into text without sending audio anywhere."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("switch", { name: /Allow online speech/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByRole("switch", { name: /Read replies aloud/ }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.getByText(/Automatic \(日本語\)/)).toBeTruthy();
    expect(
      screen.getByText("Your voice is never saved, and dot only gets the text you send."),
    ).toBeTruthy();
  });

  it("changes each choice", () => {
    const voice = control();
    render(<VoiceSection voice={voice} />);
    fireEvent.click(screen.getByRole("switch", { name: /Read replies aloud/ }));
    expect(voice.change).toHaveBeenCalledWith({ readAloud: true });
    fireEvent.click(screen.getByRole("switch", { name: /Allow online speech/ }));
    expect(voice.change).toHaveBeenCalledWith({ online: true });
  });

  it("offers the one-time download where it brings speech onto the device", () => {
    const voice = control({ route: { kind: "none", why: "download" } });
    render(<VoiceSection voice={voice} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(voice.download).toHaveBeenCalledTimes(1);
  });

  it("tells when online is the only way and it is off", () => {
    render(<VoiceSection voice={control({ route: { kind: "none", why: "online-off" } })} />);
    expect(screen.getByText("Off")).toBeTruthy();
    expect(
      screen.getByText("This browser can only do it online. Allow online speech below to use it."),
    ).toBeTruthy();
  });
});

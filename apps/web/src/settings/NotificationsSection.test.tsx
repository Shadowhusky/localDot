// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceEnv } from "../notify/this-device.ts";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { notifyDaemonFixture } from "./testing.ts";
import { useNotifications } from "./useNotifications.ts";

afterEach(() => cleanup());

const thisMac: DeviceEnv = {
  hostname: "127.0.0.1",
  isSecureContext: true,
  userAgent: "Mozilla/5.0 (Macintosh)",
  maxTouchPoints: 0,
  standalone: false,
  pushSupported: true,
  subtle: webcrypto.subtle as unknown as SubtleCrypto,
};

function Harness({ d }: { d: ReturnType<typeof notifyDaemonFixture> }) {
  const view = useNotifications(d.api, true, { env: thisMac, toast: () => {} });
  return <NotificationsSection view={view} />;
}

function setup() {
  const d = notifyDaemonFixture();
  render(<Harness d={d} />);
  return d;
}

describe("Settings › Notifications", () => {
  it("shows this Mac's line and one switch per event and channel", async () => {
    setup();
    expect(
      await screen.findByText("Notifications come from localDot itself, even with no tab open."),
    ).toBeTruthy();
    for (const label of ["Needs you", "Done", "Failed", "Routine results"]) {
      expect(screen.getByRole("switch", { name: `${label} on this Mac` })).toBeTruthy();
      expect(screen.getByRole("switch", { name: `${label} on phones` })).toBeTruthy();
    }
  });

  it("saves a switch at once", async () => {
    const d = setup();
    fireEvent.click(await screen.findByRole("switch", { name: "Done on phones" }));
    await waitFor(() => expect(d.current().events.done.phone).toBe(false));
  });

  it("shows quiet hours times only when quiet hours are on, and refuses the same time twice", async () => {
    const d = setup();
    const quiet = await screen.findByRole("switch", { name: "Quiet hours" });
    expect(screen.queryByLabelText("From")).toBeNull();
    fireEvent.click(quiet);
    await waitFor(() => expect(d.current().quietHours.enabled).toBe(true));
    const from = screen.getByLabelText("From") as HTMLInputElement;
    expect(from.closest("[inert]")).toBeNull();
    fireEvent.change(from, { target: { value: "07:00" } });
    fireEvent.blur(from);
    expect(await screen.findByText("Pick two different times.")).toBeTruthy();
    expect(d.current().quietHours.start).toBe("22:00");
    fireEvent.change(from, { target: { value: "23:30" } });
    fireEvent.blur(from);
    await waitFor(() => expect(d.current().quietHours.start).toBe("23:30"));
    expect(screen.queryByText("Pick two different times.")).toBeNull();
  });

  it("sends a test and says where it went", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    expect(await screen.findByText(/^Sent to this Mac\./)).toBeTruthy();
  });
});

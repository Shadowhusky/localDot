// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Curtain } from "./Curtain.tsx";

afterEach(cleanup);

const curtain = (phase: "starting" | "stopping", updating: boolean) =>
  render(
    <Curtain
      phase={phase}
      first={false}
      waking={false}
      updating={updating}
      caption=""
      action={{ kind: "stop", enabled: false }}
      onAction={() => {}}
      showDot={false}
    />,
  );

it("says the computer is updating through its stop and its start", () => {
  for (const phase of ["stopping", "starting"] as const) {
    curtain(phase, true);
    expect(screen.getByRole("heading").textContent).toBe("Updating your computer");
    expect(screen.getByText(/Your files and sign-ins stay/)).toBeTruthy();
    cleanup();
  }
  curtain("starting", false);
  expect(screen.getByRole("heading").textContent).toBe("Starting your computer");
});

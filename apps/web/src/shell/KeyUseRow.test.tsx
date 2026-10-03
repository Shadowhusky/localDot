// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { keyUseRow } from "../session/key-uses.ts";
import { KeyUseRow } from "./KeyUseRow.tsx";

afterEach(cleanup);

const use = {
  id: "k1",
  t: 10,
  secretId: "weather",
  host: "api.weather.example",
  method: "GET",
  path: "/v1/now",
  decision: "allow" as const,
};

describe("KeyUseRow", () => {
  it("shows the key, destination, request, and repeated count as quiet text", () => {
    const { container, rerender } = render(<KeyUseRow row={{ ...keyUseRow(use), count: 3 }} />);
    expect(screen.getByTestId("key-use").textContent).toBe(
      "Used weather key → api.weather.example×3GET /v1/now",
    );
    expect(container.querySelector(".blocked")).toBeNull();
    expect(container.querySelector(".kd")?.getAttribute("aria-hidden")).toBe("true");
    rerender(<KeyUseRow row={keyUseRow(use)} />);
    expect(container.querySelector(".kc")).toBeNull();
  });

  it("renders every untrusted request field as text with no links or executable elements", () => {
    const row = keyUseRow({
      ...use,
      decision: "deny",
      secretId: "<svg onload=alert(1)>",
      host: "<img src=x onerror=alert(1)>",
      method: "<script>oops</script>",
      path: 'javascript:alert(1)</span><a href="bad">',
    });
    const { container } = render(<KeyUseRow row={row} />);
    expect(container.querySelector(".keyuse.blocked")).not.toBeNull();
    expect(screen.getByTestId("key-use").textContent).toBe(row.label + row.detail);
    expect(container.querySelector("img, svg, script, a")).toBeNull();
  });

  it("keeps maximum protocol-sized text inside the label and request wrap containers", () => {
    const row = keyUseRow({
      ...use,
      secretId: "s".repeat(64),
      host: "h".repeat(255),
      path: "p".repeat(512),
    });
    const { container } = render(<KeyUseRow row={row} />);
    expect(container.querySelector(".kl")?.textContent).toBe(row.label);
    expect(container.querySelector(".kp")?.textContent).toBe(row.detail);
  });
});

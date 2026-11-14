// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MiddleName } from "./MiddleTruncate.tsx";

afterEach(cleanup);

const parts = (name: string) =>
  [...render(<MiddleName name={name} />).container.querySelectorAll(".ui-middle-name > span")].map(
    (span) => span.textContent,
  );

describe("a file's name", () => {
  it("keeps both ends whole around a middle that gives way", () => {
    expect(parts("quarterly-report-final.pdf").join("")).toBe("quarterly-report-final.pdf");
    expect(parts("quarterly-report-final.pdf")).toHaveLength(3);
  });

  it("keeps a middle of a character or two with the start, so no gap shows", () => {
    expect(parts("firmware.bin")).toEqual(["firmw", "are.bin"]);
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LocalView, localText } from "./LocalView.tsx";

afterEach(cleanup);

const bytes = (text: string) => new TextEncoder().encode(text);

describe("a draft's file as text", () => {
  it("reads its lines as the computer would, dropping the line cut short", () => {
    expect(localText(bytes("one\r\ntwo\nthree"), true)).toEqual({
      kind: "text",
      lines: ["one", "two", "three"],
      from: "start",
      truncated: false,
    });
    expect(localText(bytes("one\ntwo\nthr"), false)).toMatchObject({
      lines: ["one", "two"],
      truncated: true,
    });
  });

  it("isn't text with a zero byte, bytes that aren't UTF-8, or many control characters", () => {
    expect(localText(new Uint8Array([104, 0, 105]), true)).toBeNull();
    expect(localText(new Uint8Array([0xff, 0xfe, 0x41]), true)).toBeNull();
    expect(localText(new Uint8Array([1, 2, 3, 4]), true)).toBeNull();
    expect(localText(bytes("\u001b[1mbold\u001b[0m"), true)?.lines).toHaveLength(1);
  });

  it("keeps a character cut at the end of what was read", () => {
    const e = bytes("café");
    expect(localText(e.subarray(0, e.length - 1), false)?.lines).toEqual(["caf"]);
  });
});

describe("a draft's file in the viewer", () => {
  it("says a kind it can't show has no preview", async () => {
    render(
      <LocalView file={new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])], "archive.zip")} />,
    );
    expect(await screen.findByText("No preview for this kind of file")).toBeTruthy();
    expect(document.body.textContent).toContain("archive.zip");
  });

  it("shows a text file's words, and says a file that isn't text has no preview", async () => {
    render(<LocalView file={new File(["first line\nsecond line\n"], "notes.txt")} />);
    expect(await screen.findByText("second line")).toBeTruthy();
    cleanup();
    render(<LocalView file={new File([new Uint8Array([0, 1, 2])], "data.dat")} />);
    expect(await screen.findByText("No preview for this kind of file")).toBeTruthy();
  });
});

import { describe, expect, it } from "vitest";
import { kindLabel } from "./FileViewer.tsx";
import { rowsNote } from "./TableView.tsx";

describe("the table's caption", () => {
  it("says how many rows of how many show", () => {
    const rows = Array.from({ length: 500 }, () => ["a", "b"]);
    expect(rowsNote({ rows, totalRows: 12_340, columns: 2 })).toBe("Showing 1–500 of 12,340 rows");
    expect(rowsNote({ rows: rows.slice(0, 3), totalRows: 3, columns: 2 })).toBe("3 rows");
    expect(rowsNote({ rows, totalRows: null, columns: 2 })).toBe("First 500 rows");
    expect(rowsNote({ rows: [["a"]], totalRows: 1, columns: 90 })).toBe("1 row · first columns");
  });
});

describe("a file's kind, in words", () => {
  it("names each kind plainly", () => {
    expect(
      [
        "a.png",
        "a.svg",
        "a.html",
        "a.md",
        "a.py",
        "a.csv",
        "a.xlsx",
        "a.mp4",
        "a.docx",
        "a.zip",
      ].map(kindLabel),
    ).toEqual([
      "PNG picture",
      "SVG picture",
      "Web page",
      "Markdown",
      "Python",
      "CSV table",
      "Spreadsheet",
      "MP4 video",
      "DOCX document",
      "ZIP file",
    ]);
  });
});

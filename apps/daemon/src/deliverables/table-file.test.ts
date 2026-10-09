import { VIEWER_LIMITS } from "@localdot/protocol";
import { describe, expect, it } from "vitest";
import { sheetTable } from "./sheet-file.ts";
import { delimitedTable } from "./table-file.ts";
import { odsOf, xlsxOf, zipOf } from "./testing/sample-files.ts";

const KEY = `sk-proj-${"Q".repeat(40)}`;
const csv = (text: string, size?: number) =>
  delimitedTable("a.csv", Buffer.from(text), size ?? Buffer.byteLength(text));

describe("delimited tables", () => {
  it("counts every row, shows the first, and leaves trailing empty lines out", () => {
    const lines = ["Name,Note", ...Array.from({ length: 1200 }, (_, i) => `r${i},"a, ""b""\nc"`)];
    const reply = csv(`${lines.join("\n")}\n\n\n`);
    expect(reply).toMatchObject({ kind: "table", totalRows: 1201, columns: 2 });
    if (reply.kind !== "table") throw new Error("not a table");
    expect(reply.rows).toHaveLength(VIEWER_LIMITS.tableRows);
    expect(reply.rows[1]).toEqual(["r0", 'a, "b"\nc']);
  });

  it("keeps empty rows in the middle and masks keys in cells", () => {
    expect(csv(`a\n\n${KEY},b`)).toMatchObject({ rows: [["a"], [], ["••••", "b"]], totalRows: 3 });
  });

  it("has no total for a file too long to count, and drops the row cut by the read", () => {
    expect(csv("a\nb\nc", 10_000_000)).toMatchObject({ rows: [["a"], ["b"]], totalRows: null });
  });

  it("refuses binary bytes", () => {
    expect(delimitedTable("a.tsv", Buffer.from([0x61, 0, 0x62]), 3)).toEqual({
      kind: "none",
      reason: "binary",
    });
  });
});

describe("workbooks", () => {
  it("lists visible sheets and reads values, dates and gaps as Excel shows them", async () => {
    const book = xlsxOf([
      {
        name: "Q3 & Q4",
        rows: [
          ["Month", "Net"],
          ["Oct", 0.1 + 0.2],
        ],
      },
      { name: "Hidden", rows: [["x"]], hidden: true },
      { name: "Days", rows: [[new Date("2026-01-31T00:00:00Z")]] },
    ]);
    expect(await sheetTable("a.xlsx", book, 0)).toEqual({
      kind: "table",
      sheets: ["Q3 & Q4", "Days"],
      sheet: 0,
      rows: [
        ["Month", "Net"],
        ["Oct", "0.3"],
      ],
      totalRows: 2,
      columns: 2,
    });
    expect(await sheetTable("a.xlsx", book, 1)).toMatchObject({ rows: [["2026-01-31"]] });
  });

  it("fills rows and columns the file leaves out, and reads inline and rich text", async () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r></is></c></row><row r="3"><c r="A3" t="b"><v>1</v></c><c r="C3" t="e"><v>#DIV/0!</v></c></row><row r="9" spans="1:3"/></sheetData></worksheet>`;
    const book = zipOf({
      "xl/workbook.xml": '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/s.xml"/></Relationships>',
      "xl/worksheets/s.xml": sheet,
    });
    expect(await sheetTable("a.xlsx", book, 0)).toMatchObject({
      rows: [["", "ab"], [], ["TRUE", "", "#DIV/0!"]],
      totalRows: 3,
      columns: 3,
    });
  });

  it("reads LibreOffice sheets without expanding their million empty rows", async () => {
    const book = odsOf([
      {
        name: "Totals",
        rows: [
          ["Month", "Net"],
          ["Dec", 12000],
        ],
      },
      { name: "Notes", rows: [["see  below"]] },
    ]);
    const started = performance.now();
    expect(await sheetTable("a.ods", book, 0)).toEqual({
      kind: "table",
      sheets: ["Totals", "Notes"],
      sheet: 0,
      rows: [
        ["Month", "Net"],
        ["Dec", "12000"],
      ],
      totalRows: 2,
      columns: 2,
    });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("joins paragraphs, keeps runs of spaces and leaves comments out of a cell", async () => {
    const content = `<office:document-content><table:table table:name="S"><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2">
      <text:p>one<text:s text:c="2"/>two</text:p>
      <office:annotation><text:p>a comment</text:p></office:annotation>
      <text:p>three</text:p></table:table-cell></table:table-row></table:table></office:document-content>`;
    expect(await sheetTable("a.ods", zipOf({ "content.xml": content }), 0)).toMatchObject({
      rows: [
        ["one  two\nthree", "one  two\nthree"],
        ["one  two\nthree", "one  two\nthree"],
      ],
      totalRows: 2,
    });
  });

  it("refuses a workbook that inflates past the cap, whatever it declares", async () => {
    const bomb = zipOf({
      "xl/workbook.xml": '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"/></Relationships>',
      "xl/worksheets/s.xml": Buffer.alloc(VIEWER_LIMITS.sheetXmlBytes + 1, 0x20),
    });
    // The declared size is the truth here; a lying header is caught by the inflate cap instead.
    expect(await sheetTable("a.xlsx", bomb, 0)).toEqual({ kind: "none", reason: "too_large" });
    const lying = Buffer.from(bomb);
    const central = lying.lastIndexOf(Buffer.from("PK\u0001\u0002", "latin1"));
    lying.writeUInt32LE(10, central + 24);
    expect(await sheetTable("a.xlsx", lying, 0)).toEqual({ kind: "none", reason: "too_large" });
  });

  it("fails calmly on anything that is not a workbook", async () => {
    expect(await sheetTable("a.xlsx", Buffer.from("not a zip"), 0)).toEqual({
      kind: "none",
      reason: "failed",
    });
    expect(await sheetTable("a.ods", zipOf({ "other.xml": "<x/>" }), 0)).toEqual({
      kind: "none",
      reason: "failed",
    });
  });
});

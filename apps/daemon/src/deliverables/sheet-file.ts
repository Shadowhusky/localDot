import { fileExtension, type TableFileReply, VIEWER_LIMITS } from "@localdot/protocol";
import { Grid, tableReply } from "./table-file.ts";
import { Zip, ZipRefused } from "./zip.ts";

const V = VIEWER_LIMITS;

type Token = { text: string } | { name: string; close: boolean; empty: boolean; attrs: string };

// The elements and text of an XML document in one pass, linear in its length. Comments, processing
// instructions and the doctype are skipped, so no entity is ever defined or expanded.
function* xmlTokens(xml: string): Generator<Token> {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      yield { text: decode(xml.slice(i)) };
      return;
    }
    if (lt > i) yield { text: decode(xml.slice(i, lt)) };
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return;
      yield { text: xml.slice(lt + 9, end) };
      i = end + 3;
      continue;
    }
    let j = lt + 1;
    let quote = 0;
    for (; j < xml.length; j++) {
      const ch = xml.charCodeAt(j);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) quote = ch;
      else if (ch === 62) break;
    }
    if (j >= xml.length) return;
    i = j + 1;
    const first = xml[lt + 1];
    if (first === "?" || first === "!") continue;
    const close = first === "/";
    const empty = xml[j - 1] === "/";
    const inner = xml.slice(lt + (close ? 2 : 1), empty ? j - 1 : j);
    const space = inner.search(/[\s]/);
    const qualified = space < 0 ? inner : inner.slice(0, space);
    yield {
      name: qualified.slice(qualified.indexOf(":") + 1),
      close,
      empty,
      attrs: space < 0 ? "" : inner.slice(space),
    };
  }
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (all, ref) => {
    if (ref[0] !== "#") return ENTITIES[ref] ?? all;
    const code = ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0
      ? "�"
      : String.fromCodePoint(code);
  });
}
// An attribute by its local name (any prefix), decoded.
const ATTRS = new Map<string, RegExp>();
function attr(attrs: string, local: string): string | undefined {
  let pattern = ATTRS.get(local);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)(?:[^\\s=:]+:)?${local}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    ATTRS.set(local, pattern);
  }
  const m = pattern.exec(attrs);
  return m ? decode(m[1] ?? m[2] ?? "") : undefined;
}

// Parsing a large workbook gives the daemon's other work a turn every few thousand elements.
const SLICE = 8192;
function turns(): () => Promise<void> | undefined {
  let n = 0;
  return () => (++n % SLICE === 0 ? new Promise((resolve) => setImmediate(resolve)) : undefined);
}

function xmlOf(zip: Zip, name: string): string | undefined {
  const bytes = zip.read(name, V.sheetXmlBytes);
  return bytes && new TextDecoder("utf-8").decode(bytes);
}

// A workbook (.xlsx or .ods) as a table: its sheet names and the rows of one sheet. Nothing in it is
// run or evaluated: a formula shows the value the file saved with it.
export async function sheetTable(
  name: string,
  bytes: Buffer,
  sheet: number,
): Promise<TableFileReply> {
  try {
    const zip = new Zip(bytes);
    return await (fileExtension(name) === "ods" ? ods(zip, sheet) : xlsx(zip, sheet));
  } catch (error) {
    return { kind: "none", reason: error instanceof ZipRefused ? error.reason : "failed" };
  }
}

async function xlsx(zip: Zip, wanted: number): Promise<TableFileReply> {
  const workbook = xmlOf(zip, "xl/workbook.xml");
  if (workbook === undefined) throw new ZipRefused("failed");
  const sheets: { name: string; rel: string }[] = [];
  let date1904 = false;
  for (const t of xmlTokens(workbook)) {
    if (!("name" in t) || t.close) continue;
    if (t.name === "workbookPr") date1904 = /^(1|true)$/.test(attr(t.attrs, "date1904") ?? "");
    if (t.name !== "sheet" || /hidden/i.test(attr(t.attrs, "state") ?? "")) continue;
    if (sheets.length < V.sheets)
      sheets.push({ name: attr(t.attrs, "name") ?? "", rel: attr(t.attrs, "id") ?? "" });
  }
  const targets = new Map<string, string>();
  for (const t of xmlTokens(xmlOf(zip, "xl/_rels/workbook.xml.rels") ?? ""))
    if ("name" in t && t.name === "Relationship") {
      const target = attr(t.attrs, "Target") ?? "";
      targets.set(
        attr(t.attrs, "Id") ?? "",
        target.startsWith("/") ? target.slice(1) : `xl/${target}`,
      );
    }
  const chosen = sheets[wanted];
  const grid = new Grid();
  const names = sheets.map((s) => s.name.slice(0, 200));
  const path = chosen && targets.get(chosen.rel);
  const xml = path === undefined ? undefined : xmlOf(zip, path);
  if (xml === undefined) return tableReply(grid, names, wanted, chosen ? null : 0);
  const strings = await sharedStrings(xmlOf(zip, "xl/sharedStrings.xml"));
  const formats = cellFormats(xmlOf(zip, "xl/styles.xml"));
  const turn = turns();
  let row: string[] = [];
  let next = 1;
  let column = 0;
  let cell: { type: string; style: number } | undefined;
  let value = "";
  let into: "v" | "t" | undefined;
  for (const t of xmlTokens(xml)) {
    const pause = turn();
    if (pause) await pause;
    if (!("name" in t)) {
      if (into) value += t.text;
      continue;
    }
    if (t.name === "row") {
      if (t.close) {
        grid.add(row);
        row = [];
        continue;
      }
      const at = Number(attr(t.attrs, "r") ?? next) || next;
      // Rows the file leaves out are empty.
      if (at > next) grid.add([], Math.min(at - next, 1_048_576));
      next = at + 1;
      column = 0;
      if (t.empty) grid.add([]);
    } else if (t.name === "c") {
      if (t.close) {
        if (cell) placeCell(row, column, cellText(cell, value, strings, formats, date1904));
        column++;
        cell = undefined;
        into = undefined;
        continue;
      }
      const ref = attr(t.attrs, "r");
      if (ref) column = columnIndex(ref);
      cell = { type: attr(t.attrs, "t") ?? "n", style: Number(attr(t.attrs, "s") ?? 0) };
      value = "";
      if (t.empty) {
        cell = undefined;
        column++;
      }
    } else if (cell && (t.name === "v" || t.name === "t"))
      into = t.close || t.empty ? undefined : t.name;
  }
  return tableReply(grid, names, wanted, grid.total);
}

function placeCell(row: string[], column: number, text: string): void {
  if (column >= V.tableColumns * 4 && text === "") return;
  while (row.length < column) row.push("");
  row[column] = text;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + code - 64;
  }
  return Math.max(0, n - 1);
}

async function sharedStrings(xml: string | undefined): Promise<string[]> {
  const out: string[] = [];
  if (xml === undefined) return out;
  const turn = turns();
  let current: string | undefined;
  let phonetic = false;
  let text = false;
  for (const t of xmlTokens(xml)) {
    const pause = turn();
    if (pause) await pause;
    if (!("name" in t)) {
      if (current !== undefined && text && !phonetic) current += t.text;
      continue;
    }
    if (t.name === "si") {
      if (t.close || t.empty) {
        out.push(current ?? "");
        current = undefined;
      } else current = "";
    } else if (t.name === "rPh") phonetic = !t.close && !t.empty;
    else if (t.name === "t") text = !t.close && !t.empty;
  }
  return out;
}

// The number format of each cell style: whether it shows a date, a time or a percentage.
type Shown = "number" | "date" | "time" | "datetime" | "percent";
function cellFormats(xml: string | undefined): Shown[] {
  if (xml === undefined) return [];
  const custom = new Map<number, string>();
  const styles: Shown[] = [];
  let inCellXfs = false;
  for (const t of xmlTokens(xml)) {
    if (!("name" in t)) continue;
    if (t.name === "numFmt" && !t.close)
      custom.set(Number(attr(t.attrs, "numFmtId")), attr(t.attrs, "formatCode") ?? "");
    else if (t.name === "cellXfs") inCellXfs = !t.close && !t.empty;
    else if (t.name === "xf" && inCellXfs && !t.close) {
      const id = Number(attr(t.attrs, "numFmtId") ?? 0);
      styles.push(formatKind(id, custom.get(id)));
    }
  }
  return styles;
}
function formatKind(id: number, code: string | undefined): Shown {
  if (id === 9 || id === 10) return "percent";
  if ((id >= 14 && id <= 17) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return "date";
  if (id === 22) return "datetime";
  if ((id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return "time";
  if (code === undefined) return "number";
  // Quoted text, [colours and locales], escapes and padding say nothing about the kind.
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\.|[_*]./g, "").toLowerCase();
  if (bare.includes("%")) return "percent";
  const day = /[dy]/.test(bare);
  const time = /[hs]/.test(bare);
  if (day && time) return "datetime";
  // "m" alone is a month name or number, beside an hour it is minutes.
  if (day || (bare.includes("m") && !time && !/[0#?]/.test(bare))) return "date";
  return time ? "time" : "number";
}

function cellText(
  cell: { type: string; style: number },
  value: string,
  strings: string[],
  formats: Shown[],
  date1904: boolean,
): string {
  if (cell.type === "s") return strings[Number(value)] ?? "";
  if (cell.type === "b") return value === "1" ? "TRUE" : value === "" ? "" : "FALSE";
  if (cell.type !== "n" || value === "") return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const shown = formats[cell.style] ?? "number";
  if (shown === "percent") return `${Number((n * 100).toPrecision(12))}%`;
  if (shown === "number")
    return /^-?\d{1,15}(\.\d{1,6})?$/.test(value) ? value : String(Number(n.toPrecision(15)));
  const ms = Math.round((n + (date1904 ? 1462 : 0)) * 86_400_000) + Date.UTC(1899, 11, 30);
  const iso = new Date(ms).toISOString();
  if (shown === "date") return iso.slice(0, 10);
  if (shown === "time") return iso.slice(11, 16);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

async function ods(zip: Zip, wanted: number): Promise<TableFileReply> {
  const xml = xmlOf(zip, "content.xml");
  if (xml === undefined) throw new ZipRefused("failed");
  const names: string[] = [];
  const grid = new Grid();
  let table = -1;
  let inTable = false;
  let row: string[] = [];
  let rowRepeat = 1;
  let cell: { repeat: number; text: string; value: string; paragraphs: number } | undefined;
  let hidden = 0;
  // Only text inside a paragraph shows: the layout between elements is not the cell's.
  let paragraph = 0;
  const turn = turns();
  for (const t of xmlTokens(xml)) {
    const pause = turn();
    if (pause) await pause;
    if (!("name" in t)) {
      if (cell && hidden === 0 && paragraph > 0) cell.text += t.text;
      continue;
    }
    if (t.name === "table" && !t.empty) {
      if (t.close) inTable = false;
      else {
        table++;
        inTable = table === wanted;
        if (names.length < V.sheets) names.push((attr(t.attrs, "name") ?? "").slice(0, 200));
      }
      continue;
    }
    if (!inTable) continue;
    if (t.name === "table-row") {
      if (!t.close) {
        row = [];
        rowRepeat = Math.max(1, Number(attr(t.attrs, "number-rows-repeated") ?? 1) || 1);
      }
      if (t.close || t.empty) grid.add(row, Math.min(rowRepeat, 1_048_576));
    } else if (t.name === "table-cell" || t.name === "covered-table-cell") {
      if (!t.close) {
        const repeat = Math.max(1, Number(attr(t.attrs, "number-columns-repeated") ?? 1) || 1);
        const value =
          attr(t.attrs, "value") ??
          attr(t.attrs, "date-value") ??
          attr(t.attrs, "boolean-value") ??
          "";
        cell = { repeat, text: "", value, paragraphs: 0 };
        paragraph = 0;
      }
      if (cell && (t.close || t.empty)) {
        const text = cell.paragraphs > 0 || cell.text ? cell.text : cell.value;
        const room = V.tableColumns * 4 - row.length;
        for (let i = 0; i < Math.min(cell.repeat, room); i++) row.push(text);
        cell = undefined;
      }
    } else if (t.name === "annotation" && !t.empty) hidden += t.close ? -1 : 1;
    else if (!cell || hidden > 0) continue;
    else if (t.name === "p") {
      if (t.close) paragraph = Math.max(0, paragraph - 1);
      else {
        if (cell.paragraphs++ > 0) cell.text += "\n";
        if (!t.empty) paragraph++;
      }
    } else if (t.close) continue;
    else if (t.name === "s")
      cell.text += " ".repeat(Math.min(64, Math.max(1, Number(attr(t.attrs, "c") ?? 1) || 1)));
    else if (t.name === "tab") cell.text += "\t";
    else if (t.name === "line-break") cell.text += "\n";
  }
  return tableReply(grid, names, wanted, grid.total);
}

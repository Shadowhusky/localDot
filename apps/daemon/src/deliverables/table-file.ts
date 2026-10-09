import { fileExtension, type TableFileReply, VIEWER_LIMITS } from "@localdot/protocol";
import { decodeHead, maskText, visible } from "./excerpt.ts";

const V = VIEWER_LIMITS;

function filled(cells: readonly string[]): number {
  let width = cells.length;
  while (width > 0 && cells[width - 1] === "") width--;
  return width;
}

// The rows a table shows (the first ones, cut to the shown columns and cell length, masked) and how
// many it has. Empty rows count only when a row with something in it follows. A row whose cells
// past the shown columns were left out says how wide it is.
export class Grid {
  readonly rows: string[][] = [];
  total = 0;
  columns = 0;
  #blank = 0;

  add(cells: readonly string[], repeat = 1, width = filled(cells)): void {
    if (width === 0) {
      this.#blank += repeat;
      return;
    }
    this.total += this.#blank;
    for (let i = Math.min(this.#blank, V.tableRows - this.rows.length); i > 0; i--)
      this.rows.push([]);
    this.#blank = 0;
    this.columns = Math.max(this.columns, width);
    this.total += repeat;
    const room = Math.min(repeat, V.tableRows - this.rows.length);
    if (room <= 0) return;
    const shown = Array.from({ length: Math.min(width, V.tableColumns) }, (_, i) =>
      visible(cells[i] ?? "", V.tableCellChars, maskText),
    );
    for (let i = 0; i < room; i++) this.rows.push([...shown]);
  }
}

// RFC 4180, comma for .csv and tab for .tsv; a quoted field may span lines. A file longer than the
// counting cap shows its first rows with no total.
export function delimitedTable(name: string, bytes: Uint8Array, fileBytes: number): TableFileReply {
  const complete = fileBytes <= bytes.byteLength;
  const text = decodeHead(bytes, complete);
  if (text === undefined) return { kind: "none", reason: "binary" };
  const delimiter = fileExtension(name) === "tsv" ? "\t" : ",";
  const grid = new Grid();
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      grid.add(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  // An incomplete read ends mid-row: that row is left out.
  if (complete && (cell !== "" || row.length > 0)) {
    row.push(cell);
    grid.add(row);
  }
  return tableReply(grid, [], 0, complete ? grid.total : null);
}

export function tableReply(
  grid: Grid,
  sheets: string[],
  sheet: number,
  totalRows: number | null,
): TableFileReply {
  return bounded({
    kind: "table",
    sheets,
    sheet,
    rows: grid.rows,
    totalRows,
    columns: grid.columns,
  });
}

// The reply never exceeds tableJsonBytes: rows are dropped from the end.
function bounded(reply: Extract<TableFileReply, { kind: "table" }>): TableFileReply {
  let rows = reply.rows;
  for (;;) {
    const body = { ...reply, rows };
    if (Buffer.byteLength(JSON.stringify(body)) <= V.tableJsonBytes) return body;
    if (rows.length === 0) return { kind: "none", reason: "too_large" };
    rows = rows.slice(0, Math.max(0, Math.floor(rows.length * 0.8)));
  }
}

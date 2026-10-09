import { crc32, deflateRawSync } from "node:zlib";

// Real files of each kind the full preview reads, made in memory for tests and the fixture.

export function zipOf(entries: Record<string, string | Buffer>, store = false): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === "string" ? Buffer.from(content) : content;
    const body = store ? data : deflateRawSync(data);
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, body);
    centrals.push(central, fileName);
    offset += 30 + fileName.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const column = (n: number) => {
  let s = "";
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26))
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

export type SampleSheet = { name: string; rows: (string | number | Date)[][]; hidden?: boolean };

// A workbook as Excel writes it: shared strings, styled dates, one worksheet per sheet.
export function xlsxOf(sheets: SampleSheet[]): Buffer {
  const strings: string[] = [];
  const shared = (text: string) => {
    const at = strings.indexOf(text);
    return at >= 0 ? at : strings.push(text) - 1;
  };
  const files: Record<string, string> = {};
  sheets.forEach((sheet, i) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((value, c) => {
            const ref = `${column(c)}${r + 1}`;
            if (value instanceof Date) {
              const serial = value.getTime() / 86_400_000 + 25_569;
              return `<c r="${ref}" s="1"><v>${serial}</v></c>`;
            }
            if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
            return `<c r="${ref}" t="s"><v>${shared(value)}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  const listed = sheets
    .map(
      (s, i) =>
        `<sheet name="${xml(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`,
    )
    .join("");
  const rels = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("");
  return zipOf({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${listed}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    "xl/styles.xml":
      '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join("")}</sst>`,
    ...files,
  });
}

// A spreadsheet as LibreOffice writes it, with the long repeated empty rows it ends on.
export function odsOf(sheets: SampleSheet[]): Buffer {
  const tables = sheets
    .map((sheet) => {
      const rows = sheet.rows
        .map(
          (row) =>
            `<table:table-row>${row
              .map((value) =>
                typeof value === "number"
                  ? `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`
                  : `<table:table-cell office:value-type="string"><text:p>${xml(String(value))}</text:p></table:table-cell>`,
              )
              .join("")}<table:table-cell table:number-columns-repeated="1020"/></table:table-row>`,
        )
        .join("\n");
      return `<table:table table:name="${xml(sheet.name)}">\n${rows}\n<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="1024"/></table:table-row></table:table>`;
    })
    .join("");
  return zipOf({
    mimetype: "application/vnd.oasis.opendocument.spreadsheet",
    "content.xml": `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`,
  });
}

// A PDF of plain pages: each a title, lines of text and a few bars, in a standard font.
export function pdfOf(pages: { title: string; lines: string[]; bars?: number[] }[]): Buffer {
  const text = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const kids: string[] = [];
  for (const page of pages) {
    const ops = [
      "0.12 0.13 0.15 rg",
      `BT /F2 22 Tf 72 712 Td (${text(page.title)}) Tj ET`,
      "0.30 0.31 0.34 rg",
      ...page.lines.map((line, i) => `BT /F1 11 Tf 72 ${676 - i * 17} Td (${text(line)}) Tj ET`),
      ...(page.bars ?? []).map((h, i) => `0.25 0.45 0.78 rg ${72 + i * 46} 140 30 ${h} re f`),
    ].join("\n");
    add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    const contents = objects.length;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`,
    );
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A soft two-second tone as 16-bit mono WAV.
export function wavOf(seconds = 2, rate = 16_000): Buffer {
  const samples = Math.round(seconds * rate);
  const out = Buffer.alloc(44 + samples * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 2000, (samples - i) / 2000);
    out.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 6000 * fade),
      44 + i * 2,
    );
  }
  return out;
}

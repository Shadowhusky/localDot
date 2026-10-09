// biome-ignore-all lint/suspicious/noArrayIndexKey: A table's rows and cells have no identity but their position.
import type { TableFileReply } from "@localdot/protocol";
import { type ReactNode, useEffect, useId, useState } from "react";
import { count } from "../../copy/format.ts";
import type { ApiClient } from "../../lib/api.ts";
import { TabPanel, Tabs } from "../../ui/Tabs.tsx";
import { loadTable } from "../api.ts";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./states.tsx";

type Table = Extract<TableFileReply, { kind: "table" }>;
const NUMERIC = /^[\s$€£¥+−-]*[\d.,]+\s*%?$/;
const REASONS: Partial<Record<string, string>> = {
  too_large: "Too large to preview",
  binary: "This file isn't a table",
  missing: "This version is no longer available",
};

// What the caption says: every row when all are shown, else how many of how many.
export function rowsNote(table: Pick<Table, "rows" | "totalRows" | "columns">): string {
  const shown = table.rows.length;
  const columns = table.columns > (table.rows[0]?.length ?? 0) ? " · first columns" : "";
  if (table.totalRows === null) return `First ${count(shown, "row", "rows")}${columns}`;
  if (table.totalRows <= shown) return `${count(table.totalRows, "row", "rows")}${columns}`;
  return `Showing 1–${shown.toLocaleString("en-GB")} of ${table.totalRows.toLocaleString("en-GB")} rows${columns}`;
}

// A table with its first row held at the top and row numbers down the side; a workbook's sheets as
// tabs, each read when chosen. `lead` starts the bar, such as a workbook's Table | Pages.
export function TableView({
  api,
  sessionId,
  name,
  version,
  lead,
}: {
  api: ApiClient;
  sessionId: string;
  name: string;
  version: number | null;
  lead?: ReactNode;
}) {
  const tabs = useId();
  const [sheet, setSheet] = useState(0);
  const [loaded, setLoaded] = useState<{ sheet: number; reply: TableFileReply | "failed" } | null>(
    null,
  );
  const [sheets, setSheets] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    loadTable(api, sessionId, name, version, sheet, controller.signal).then(
      (reply) => {
        if (controller.signal.aborted) return;
        setLoaded({ sheet, reply });
        if (reply.kind === "table" && reply.sheets.length) setSheets(reply.sheets);
      },
      () => !controller.signal.aborted && setLoaded({ sheet, reply: "failed" }),
    );
    return () => controller.abort();
  }, [api, sessionId, name, version, sheet]);
  const reply = loaded?.sheet === sheet ? loaded.reply : null;
  const table = reply && reply !== "failed" && reply.kind === "table" ? reply : null;
  const bar =
    lead || sheets.length > 1 || table ? (
      <ViewerBar note={table ? rowsNote(table) : undefined}>
        {lead}
        {sheets.length > 1 && (
          <div className="viewer-sheets">
            <Tabs
              id={tabs}
              size={28}
              aria-label="Sheets"
              value={String(sheet)}
              items={sheets.map((label, i) => ({
                value: String(i),
                label: label || `Sheet ${i + 1}`,
              }))}
              onValueChange={(value) => setSheet(Number(value))}
            />
          </div>
        )}
      </ViewerBar>
    ) : null;
  if (reply === null)
    return (
      <>
        {bar}
        <ViewerLoading label="Loading the table" />
      </>
    );
  if (!table)
    return (
      <>
        {bar}
        <ViewerMessage
          name={name}
          title={
            (reply !== "failed" && reply.kind === "none" && REASONS[reply.reason]) ||
            "Can't show this table"
          }
        />
      </>
    );
  const [head = [], ...rows] = table.rows;
  const width = Math.max(1, ...table.rows.map((row) => row.length));
  const numeric = Array.from(
    { length: width },
    (_, c) => rows.length > 0 && rows.every((row) => !row[c] || NUMERIC.test(row[c] as string)),
  );
  const cells = (row: string[]) => Array.from({ length: width }, (_, c) => row[c] ?? "");
  return (
    <>
      {bar}
      <TabPanel
        tabsId={tabs}
        value={String(sheet)}
        selected={String(sheet)}
        className="viewer-stage viewer-table"
      >
        {table.rows.length === 0 ? (
          <ViewerMessage name={name} title="This sheet is empty" />
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The table scrolls both ways, so keyboard users can focus it.
          <div className="viewer-table-scroll" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th className="viewer-row-number" scope="col" aria-label="Row">
                    1
                  </th>
                  {cells(head).map((cell, c) => (
                    <th key={c} scope="col" data-numeric={numeric[c] || undefined} title={cell}>
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, r) => (
                  <tr key={r}>
                    <th className="viewer-row-number" scope="row">
                      {r + 2}
                    </th>
                    {cells(row).map((cell, c) => (
                      <td
                        key={c}
                        data-numeric={numeric[c] || undefined}
                        title={cell.length > 40 ? cell : undefined}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TabPanel>
    </>
  );
}

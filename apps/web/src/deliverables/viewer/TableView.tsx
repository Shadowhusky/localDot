// biome-ignore-all lint/suspicious/noArrayIndexKey: A table's rows and cells have no identity but their position.
import type { TableFileReply } from "@localdot/protocol";
import { type ReactNode, useEffect, useId, useState } from "react";
import { count } from "../../copy/format.ts";
import { locale, t, tr } from "../../i18n/index.ts";
import type { ApiClient } from "../../lib/api.ts";
import { TabPanel, Tabs } from "../../ui/Tabs.tsx";
import { type FileRef, loadTable } from "../api.ts";
import { ViewerBar, ViewerLoading, ViewerMessage } from "./states.tsx";

type Table = Extract<TableFileReply, { kind: "table" }>;
const NUMERIC = /^[\s$€£¥+−-]*[\d.,]+\s*%?$/;
const PROBLEMS: Partial<Record<string, string>> = {
  computer_off: tr("Turn on your computer to see this file"),
  busy: tr("Your computer is busy"),
  failed: tr("Couldn't load this table"),
  missing: tr("This version is no longer available"),
};

// What the caption says: every row when all are shown, else how many of how many.
export function rowsNote(table: Pick<Table, "rows" | "totalRows" | "columns">): string {
  const shown = table.rows.length;
  const rows =
    table.totalRows === null
      ? shown === 1
        ? t`First ${shown.toLocaleString(locale())} row`
        : t`First ${shown.toLocaleString(locale())} rows`
      : table.totalRows <= shown
        ? count(table.totalRows, "row", "rows")
        : t`Showing 1–${shown.toLocaleString("en-GB")} of ${table.totalRows.toLocaleString("en-GB")} rows`;
  return table.columns > (table.rows[0]?.length ?? 0) ? `${rows} · ${t`first columns`}` : rows;
}

// A table with its first row held at the top and row numbers down the side; a workbook's sheets as
// tabs, each read when chosen. `lead` starts the bar, such as a workbook's Table | Pages.
export function TableView({
  api,
  file,
  lead,
}: {
  api: ApiClient;
  file: FileRef;
  lead?: ReactNode;
}) {
  const { name } = file;
  const key = JSON.stringify(file);
  const tabs = useId();
  const [sheet, setSheet] = useState(0);
  const [loaded, setLoaded] = useState<{ sheet: number; reply: TableFileReply | "failed" } | null>(
    null,
  );
  const [sheets, setSheets] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names the file; attempt asks again.
  useEffect(() => {
    const controller = new AbortController();
    loadTable(api, file, sheet, controller.signal).then(
      (reply) => {
        if (controller.signal.aborted) return;
        setLoaded({ sheet, reply });
        if (reply.kind === "table" && reply.sheets.length) setSheets(reply.sheets);
      },
      () => !controller.signal.aborted && setLoaded({ sheet, reply: "failed" }),
    );
    return () => controller.abort();
  }, [api, key, sheet, attempt]);
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
              aria-label={t`Sheets`}
              value={String(sheet)}
              items={sheets.map((label, i) => ({
                value: String(i),
                label: label || t`Sheet ${i + 1}`,
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
        <ViewerLoading label={t`Loading the table`} />
      </>
    );
  const problem = reply === "failed" || reply.kind !== "none" ? "failed" : reply.reason;
  if (!table)
    return (
      <>
        {bar}
        <ViewerMessage
          name={name}
          title={PROBLEMS[problem]}
          retry={
            problem === "failed" || problem === "busy" ? () => setAttempt((n) => n + 1) : undefined
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
          <ViewerMessage name={name} title={t`This sheet is empty`} />
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The table scrolls both ways, so keyboard users can focus it.
          <div className="viewer-table-scroll" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  <th className="viewer-row-number" scope="col" aria-label={t`Row`}>
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

import { createRequire } from "node:module";
import type * as Sqlite from "node:sqlite";

export type DatabaseSync = Sqlite.DatabaseSync;
export type StatementSync = Sqlite.StatementSync;

const EXPERIMENTAL_NOTICE = "SQLite is an experimental feature";

// node:sqlite emits an ExperimentalWarning when first loaded; drop that one warning and no other.
function loadSqlite(): typeof Sqlite {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (typeof warning === "string" && warning.startsWith(EXPERIMENTAL_NOTICE)) return;
    Reflect.apply(emitWarning, process, [warning, ...rest]);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

export const { DatabaseSync } = loadSqlite();

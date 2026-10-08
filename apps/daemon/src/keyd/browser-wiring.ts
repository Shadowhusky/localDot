import { X509Certificate } from "node:crypto";
import { type BrowserLedger, BrowserLifecycleError } from "../cells/browser-ledger.ts";
import type { KeydClient } from "./client.ts";

export type BrowserKeydClient = Pick<KeydClient, "cell" | "openCell" | "closeCell">;

export async function closeBrowserKeyd(
  keyd: BrowserKeydClient,
  record: BrowserLedger,
): Promise<void> {
  const existing = await keyd.cell(record.id);
  if (
    existing &&
    (existing.cellId !== record.id ||
      existing.role !== "browser" ||
      existing.port !== record.keydPort)
  )
    throw new BrowserLifecycleError("Browser key listener ownership changed");
  await keyd.closeCell(record.id);
  if (await keyd.cell(record.id))
    throw new BrowserLifecycleError("Browser key listener is still present");
}

export async function openBrowserKeyd(
  keyd: BrowserKeydClient,
  record: BrowserLedger,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const opened = await keyd.openCell({
    cellId: record.id,
    role: "browser",
    port: record.keydPort,
    secrets: [],
  });
  signal.throwIfAborted();
  if (
    opened.cellId !== record.id ||
    opened.port !== record.keydPort ||
    !/^[A-Za-z0-9_-]{43}$/u.test(opened.proxyToken) ||
    Object.keys(opened.surrogates ?? {}).length !== 0 ||
    typeof opened.caCertPem !== "string" ||
    opened.caCertPem.length > 16384 ||
    !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/u.test(
      opened.caCertPem,
    )
  )
    throw new BrowserLifecycleError("Browser key material is invalid");
  try {
    if (!new X509Certificate(opened.caCertPem).ca) throw new Error();
  } catch {
    throw new BrowserLifecycleError("Browser key material is invalid");
  }
  const actual = await keyd.cell(record.id);
  signal.throwIfAborted();
  if (
    actual?.cellId !== record.id ||
    actual.role !== "browser" ||
    actual.port !== record.keydPort ||
    (actual.surrogates?.length ?? 0) !== 0 ||
    (actual.intercepts?.length ?? 0) !== 0
  )
    throw new BrowserLifecycleError("Browser key listener identity is invalid");
  return Buffer.from(
    JSON.stringify({
      v: 1,
      browserCellId: record.id,
      parentCellId: record.parentCellId,
      proxyToken: opened.proxyToken,
      caCertPem: opened.caCertPem,
    }),
    "utf8",
  );
}

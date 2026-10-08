import { ULID_PATTERN } from "@localdot/protocol";
import { z } from "zod";
import { QuarantineItem, QuarantineRelease } from "../../../../packages/protocol/src/quarantine.ts";
import type { ApiClient } from "../lib/api.ts";

export function releaseRequest(item: QuarantineItem) {
  return QuarantineRelease.parse({
    revision:
      item.state === "releasing" || item.state === "released"
        ? item.release.approvedRevision
        : item.revision,
    name: item.name,
    bytes: item.bytes,
    sha256: item.sha256,
    to: "computer",
  });
}
function root(parent: string): string {
  if (!ULID_PATTERN.test(parent)) throw new Error("Invalid computer.");
  return `/api/cells/${parent}/quarantine`;
}
export async function listDownloads(
  api: ApiClient,
  parent: string,
  signal: AbortSignal,
): Promise<QuarantineItem[]> {
  const parsed = z
    .strictObject({ items: QuarantineItem.array().max(4096) })
    .parse(await api.get(root(parent), { signal }));
  if (
    parsed.items.some((item) => item.parentCellId !== parent) ||
    new Set(parsed.items.map((item) => item.id)).size !== parsed.items.length
  )
    throw new Error("Download ownership could not be verified.");
  return parsed.items;
}
export async function changeDownload(
  api: ApiClient,
  parent: string,
  raw: QuarantineItem,
  action: "release" | "discard",
  signal: AbortSignal,
): Promise<QuarantineItem> {
  const item = QuarantineItem.parse(raw);
  if (item.parentCellId !== parent) throw new Error("The computer changed.");
  const body = action === "release" ? releaseRequest(item) : { revision: item.revision };
  const response = await api.fetch(
    `${api.socketUrl("").replace(/^ws/, "http")}${root(parent)}/${item.id}/${action}`,
    {
      method: "POST",
      headers: { authorization: api.authorization(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(610000)]),
      redirect: "error",
      cache: "no-store",
    },
  );
  if (response.status === 401) api.rejectUnauthorized?.();
  const reader = response.body?.getReader();
  try {
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
      !reader
    )
      throw new Error("Download change was not confirmed.");
    let size = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) throw new Error("Download reply is too large.");
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    const result = QuarantineItem.parse(JSON.parse(text));
    if (
      result.id !== item.id ||
      result.parentCellId !== parent ||
      result.browserCellId !== item.browserCellId ||
      result.browserInstance !== item.browserInstance ||
      result.browserDownloadGuid !== item.browserDownloadGuid ||
      result.sessionId !== item.sessionId ||
      result.name !== item.name ||
      result.bytes !== item.bytes ||
      result.sha256 !== item.sha256 ||
      result.source !== item.source ||
      (action === "discard"
        ? result.state !== "discarded"
        : result.state !== "released" && result.state !== "held")
    )
      throw new Error("Download reply changed its identity.");
    return result;
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

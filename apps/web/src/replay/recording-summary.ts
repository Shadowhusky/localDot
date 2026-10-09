import { useEffect, useState } from "react";
import { readThread } from "../agent/earlier.ts";
import type { AgentResult } from "../agent/model.ts";
import type { ThreadItem } from "../agent/thread.ts";
import { spendText } from "../copy/format.ts";
import type { ApiClient } from "../lib/api.ts";

const LINE_CHARS = 140;

// What the library's preview says about a recording beyond its card: dot's last line, the files it
// made and what its model calls cost.
export interface RecordingSummary {
  line: string;
  files: AgentResult["files"];
  spend: string | null;
}

// One line of dot's words without their Markdown: the first paragraph, its marks dropped and its
// links reduced to their text.
export function plainLine(text: string): string {
  const paragraph =
    text
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("```")) ?? "";
  const plain = paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|[^\p{L}\p{N}])[*_]([^*_]+)[*_]/gu, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > LINE_CHARS ? `${plain.slice(0, LINE_CHARS - 1).trimEnd()}…` : plain;
}

export function summarise(items: readonly ThreadItem[]): RecordingSummary {
  const said = items.findLast(
    (item) => item.kind === "message" && item.message.role === "assistant" && item.message.text,
  );
  const result = items.findLast((item) => item.kind === "result");
  const files = new Map<string, AgentResult["files"][number]>();
  let usd = 0;
  let estimated = false;
  for (const item of items) {
    if (item.kind === "result") for (const file of item.result.files) files.set(file.path, file);
    if (item.kind === "work" && item.spend) {
      usd += item.spend.usd;
      estimated ||= item.spend.estimated;
    }
  }
  const text =
    said?.kind === "message"
      ? said.message.text
      : result?.kind === "result"
        ? result.result.summary
        : "";
  return {
    line: plainLine(text),
    files: [...files.values()],
    spend: usd > 0 ? spendText(usd, estimated) : null,
  };
}

const read = new Map<string, RecordingSummary>();

// The summary of one recording, read once from its history and kept for when it is chosen again.
export function useRecordingSummary(api: ApiClient, sessionId: string | null) {
  const [summary, setSummary] = useState<{ id: string; value: RecordingSummary } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const held = read.get(sessionId);
    if (held) {
      setSummary({ id: sessionId, value: held });
      return;
    }
    const controller = new AbortController();
    readThread(api, sessionId, controller.signal)
      .then((items) => {
        const value = summarise(items);
        read.set(sessionId, value);
        if (!controller.signal.aborted) setSummary({ id: sessionId, value });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, sessionId]);
  return summary?.id === sessionId ? summary.value : null;
}

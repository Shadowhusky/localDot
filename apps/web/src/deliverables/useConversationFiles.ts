import type { ConversationFile } from "@localdot/protocol";
import { useEffect, useMemo, useState } from "react";
import type { AgentResult } from "../agent/model.ts";
import type { ApiClient } from "../lib/api.ts";
import { loadConversationFiles } from "./api.ts";

// The rows a conversation's files make as results, oldest first, each knowing its own task. A
// result the task has handed over since they were read is added under them.
export function conversationResults(
  files: readonly ConversationFile[],
  own: readonly AgentResult[],
  sessionId: string,
): AgentResult[] {
  const results = new Map<string, AgentResult>();
  for (const file of [...files].reverse()) {
    const found = results.get(file.resultId);
    const row = {
      name: file.name,
      path: file.path,
      bytes: file.bytes,
      ...(file.version === undefined ? {} : { version: file.version }),
      ...(file.available ? {} : { gone: true as const }),
    };
    results.set(file.resultId, {
      id: file.resultId,
      sessionId: file.sessionId,
      at: file.tMs * 1000,
      summary: "",
      files: [...(found?.files ?? []), row],
    });
  }
  for (const result of own)
    if (!results.has(result.id)) results.set(result.id, { ...result, sessionId });
  return [...results.values()];
}

// The files of the conversation this task belongs to, read again as it hands more over. Until they
// are in, or where they can't be read (a shared link, Replay), the task's own stand for them.
export function useConversationFiles(
  api: ApiClient,
  sessionId: string | null,
  own: readonly AgentResult[],
): { results: readonly AgentResult[]; more: boolean } {
  const [read, setRead] = useState<{
    owner: string;
    files: readonly ConversationFile[];
    more: boolean;
  } | null>(null);
  const handed = own.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another result reads them again.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    loadConversationFiles(api, sessionId, controller.signal).then(
      ({ files, more }) => {
        if (!controller.signal.aborted) setRead({ owner: sessionId, files, more });
      },
      () => {},
    );
    return () => controller.abort();
  }, [api, sessionId, handed]);
  const known = read && read.owner === sessionId && sessionId ? read : null;
  return useMemo(
    () => ({
      results: known && sessionId ? conversationResults(known.files, own, sessionId) : own,
      more: known?.more ?? false,
    }),
    [known, own, sessionId],
  );
}

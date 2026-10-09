import type { FileVersion } from "@localdot/protocol";
import { useEffect, useState } from "react";
import type { ApiClient } from "../lib/api.ts";
import { loadVersions } from "./api.ts";

// The file's versions across its task and the tasks it revises; `refresh` changes when the
// conversation gets another result.
export function useVersions(
  api: ApiClient,
  sessionId: string,
  name: string,
  refresh: number,
): FileVersion[] | null {
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  useEffect(() => {
    void refresh;
    const controller = new AbortController();
    loadVersions(api, sessionId, name, controller.signal).then(
      (reply) => {
        if (!controller.signal.aborted) setVersions(reply.versions);
      },
      () => {},
    );
    return () => controller.abort();
  }, [api, sessionId, name, refresh]);
  return versions;
}

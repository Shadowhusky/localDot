import { closeSync, readSync, statSync } from "node:fs";
import { BALANCED_AUTONOMY, type ToolName } from "@localdot/protocol";
import { decodeHead } from "../../deliverables/excerpt.ts";
import { conversationFiles } from "../../deliverables/lineage.ts";
import type { StoredFiles } from "../../deliverables/stored.ts";
import type { TaskScanner } from "../../deliverables/task-scan.ts";
import type { DesktopdClient } from "../../desktopd/client.ts";
import type { DesktopdTools } from "../../desktopd/tools-client.ts";
import type { FrameStore } from "../../gateway/frames.ts";
import type { WindowOwners } from "../../gateway/window-owners.ts";
import type { FramePng } from "../frame-png.ts";
import { outputPath } from "../output-store.ts";
import type { Redactor } from "../redact.ts";
import { runsUnasked, toolRisk } from "../safety/authorize.ts";
import type { AgentSession } from "../session.ts";
import type { AgentSettings } from "../settings.ts";
import type { RecallHit, ToolCallContext } from "../tools/deps.ts";
import type { WebAccess } from "../web/cell.ts";
import { freshDesktopLook } from "./screen.ts";
import type { HandedFile, SideReaders } from "./tools.ts";

export interface SideReaderDeps {
  frames: Pick<FrameStore, "path">;
  png: Pick<FramePng, "png">;
  // The computer's tools, while it takes them; undefined when it is off, frozen or being replaced.
  desktop(cellId: string): Pick<DesktopdTools, "readFile" | "listDir" | "fetchFile"> | undefined;
  device(cellId: string): { client: Pick<DesktopdClient, "observe"> } | undefined;
  owners(cellId: string): Pick<WindowOwners, "foreign" | "known">;
  // Who is acting on the computer now.
  holder(cellId: string): string | undefined;
  scale(cellId: string): number | undefined;
  // The computer a task ran on, however long ago.
  cellOf(sessionId: string): string | undefined;
  scanner: Pick<TaskScanner, "scan">;
  stored: Pick<StoredFiles, "exists" | "open">;
  // The tasks of the conversation this one belongs to.
  chain(sessionId: string): readonly string[];
  recall?(query: string, limit: number, excludeSessionId: string): RecallHit[];
  recallExperience?(query: string, excludeSessionId: string): string;
  web?: WebAccess;
  settings(): AgentSettings;
  redactor(session: AgentSession | undefined, cellId: string | undefined): Redactor;
  now(): number;
}

// What the user's settings say for a task with no session left: its decisions need only these.
function restingPolicy(settings: AgentSettings) {
  return {
    permissionMode: () => settings.permissionMode ?? "custom",
    autonomy: settings.autonomy ?? BALANCED_AUTONOMY,
    taskAutonomy: { relaxes: () => false, signedIn: () => false },
  } as unknown as AgentSession;
}

export function sideReaders(
  deps: SideReaderDeps,
  sessionId: string,
  session: AgentSession | undefined,
  logFile: string,
): SideReaders {
  const cellId = session?.cellId ?? deps.cellOf(sessionId);
  const redact = deps.redactor(session, cellId);
  const policy = {
    session: session ?? restingPolicy(deps.settings()),
    redact,
  } as unknown as ToolCallContext;
  return {
    sessionId,
    logFile,
    redact,
    frame: async (frameId, region, signal) => {
      const file = deps.frames.path(sessionId, frameId);
      if (!file) return undefined;
      const png = await deps.png.png(sessionId, frameId, region, signal);
      return { png, ageMs: Math.max(0, deps.now() - statSync(file).mtimeMs) };
    },
    ...(session && cellId
      ? {
          freshScreen: (newestAgeMs: number | undefined, signal: AbortSignal) =>
            freshDesktopLook(
              {
                sessionId,
                cellId,
                onDesktop: () =>
                  !session.stopped &&
                  !session.controlHeld &&
                  !session.safetyPause &&
                  (session.screens?.selection.screen ?? "desktop") === "desktop",
                acting: () => deps.holder(cellId) !== undefined,
                device: () => deps.device(cellId),
                owners: () => deps.owners(cellId),
                scale: () => deps.scale(cellId) ?? 1,
              },
              newestAgeMs,
              signal,
            ),
        }
      : {}),
    desktop: () => (cellId ? deps.desktop(cellId) : undefined),
    handedFiles: async (): Promise<readonly HandedFile[]> => {
      const { files } = await conversationFiles(
        {
          scan: (id) => deps.scanner.scan(id),
          stored: (id, name, version) => {
            const rel = outputPath(id, name, version);
            return !!rel && deps.stored.exists(rel);
          },
        },
        deps.chain(sessionId),
      );
      return files.map((file) => ({
        sessionId: file.sessionId,
        name: file.name,
        bytes: file.bytes,
        available: file.available,
      }));
    },
    handedFile: (id, name, maxBytes) => {
      const rel = outputPath(id, name, null);
      const opened = rel ? deps.stored.open(rel) : undefined;
      if (!opened) return undefined;
      try {
        const head = Buffer.alloc(Math.min(opened.size, maxBytes));
        const read = readSync(opened.fd, head, 0, head.length, 0);
        return decodeHead(head.subarray(0, read), read === opened.size);
      } finally {
        closeSync(opened.fd);
      }
    },
    ...(deps.recall ? { recall: deps.recall } : {}),
    ...(deps.recallExperience ? { recallExperience: deps.recallExperience } : {}),
    ...(deps.web ? { web: deps.web } : {}),
    permitted: (tool: ToolName, input: unknown) => {
      const facts = toolRisk(tool, input);
      if (!facts) return true;
      return runsUnasked(policy, { tool, input, target: null, facts });
    },
  };
}

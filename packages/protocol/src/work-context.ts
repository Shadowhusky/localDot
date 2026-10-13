import { z } from "zod";

// One contract shared by every agent backend. Availability never implies authorization.
export const WorkContextInput = z.object({
  goal: z.enum(["app", "code", "web", "desktop"]).optional(),
  app: z.string().min(1).max(80).optional(),
});
export type WorkContextInput = z.infer<typeof WorkContextInput>;
export const WORK_CONTEXT_DESCRIPTION =
  "Inspect current work surfaces, installed command-line tools, connected-app operations and recent failures before choosing an approach or asking for access. goal: app, code, web or desktop; optional app filters connected tools. Read-only: does not sign in, switch screens, start another browser or invoke connected apps. Connector access, browser sessions and CLI authorization are separate. Unknown means not checked, not signed out.";

// A bounded inventory served by desktopd, without executing programs or reading shell profiles.
export const WORK_PROGRAMS = [
  "git",
  "gh",
  "node",
  "python3",
  "curl",
  "unzip",
  "ffmpeg",
  "libreoffice",
] as const;
export const ProgramAvailability = z.enum(["available", "not_on_path", "unknown"]);
export const DesktopCapabilities = z.strictObject({
  version: z.literal(1),
  search: z.literal("service_path"),
  programs: z.record(z.enum(WORK_PROGRAMS), ProgramAvailability),
});
export type DesktopCapabilities = z.infer<typeof DesktopCapabilities>;

export const ToolRecovery = z.strictObject({
  repeated: z.number().int().min(2).max(1000).optional(),
  kind: z.enum([
    "unavailable",
    "authentication",
    "permission",
    "invalid_input",
    "stale",
    "timeout",
    "uncertain",
    "repeated_failure",
    "download_pending",
    "tool_error",
  ]),
  surface: z.enum(["connector", "browser", "desktop", "web", "runtime"]),
  retry: z.enum(["after_observation", "after_change", "verify_first", "never"]),
});
export type ToolRecovery = z.infer<typeof ToolRecovery>;

export function recoveryAdvice(recovery: ToolRecovery): string {
  switch (recovery.kind) {
    case "authentication":
      return "This connection needs authentication. Other connections have independent access; check work_context and existing access before requesting a sign-in. Never copy credentials between surfaces.";
    case "permission":
      return "Access to this operation was refused. Do not repeat it or bypass the restriction through another tool. A new login is not evidence of permission.";
    case "unavailable":
      return "This work surface is unavailable. Check work_context; preserve its state and sign-ins. Retry once after recovery, or use another already authorized surface.";
    case "invalid_input":
      return "Correct the tool arguments using its schema before retrying; this is not a sign-in failure.";
    case "stale":
      return "Read the current page or screen again and use fresh targets. Do not replay input against the old observation.";
    case "timeout":
      return "The operation timed out. Check whether it completed before any retry, especially for writes; a timeout does not prove nothing happened.";
    case "uncertain":
      return "The result is uncertain. Do not replay the operation. Verify the external state or explain the blocker; do not duplicate a possible side effect.";
    case "repeated_failure":
      return "The same attempt has failed repeatedly. Inspect work_context and new evidence, then change the approach. Do not loop or ask for credentials without evidence that authentication is missing.";
    case "download_pending":
      return "The download has started; the original page remains open. Check Activity > Downloads for completion and Review before using the file. Do not navigate repeatedly or claim the file is already on the computer.";
    case "tool_error":
      return "The tool reported a failure, not a proven authentication failure. Inspect its result and current state before changing access or retrying a possible write.";
  }
}

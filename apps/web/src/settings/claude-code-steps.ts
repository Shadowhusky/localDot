import type { ClaudeCodeStatus } from "@localdot/protocol";
import type { GlyphState } from "../ui/StatusGlyph.tsx";

export interface ClaudeCodeStep {
  id: "install" | "sign-in";
  title: string;
  detail: string;
  state: GlyphState;
}

export const planName = (plan: string) =>
  `${plan.charAt(0).toUpperCase()}${plan.slice(1).replaceAll(/[_-]/g, " ")}`;

// Install, then sign in, both in Claude Code itself; localDot only looks.
export function claudeCodeSteps(
  status: ClaudeCodeStatus | null,
  checking: boolean,
): ClaudeCodeStep[] {
  const install = { id: "install", title: "Install Claude Code" } as const;
  const signIn = { id: "sign-in", title: "Sign in to Claude Code" } as const;
  const waiting = {
    ...signIn,
    state: "todo",
    detail: "With your Claude plan, in Terminal",
  } as const;
  const looking = { state: "doing", detail: "Checking…" } as const;
  if (!status) return [{ ...install, ...looking }, waiting];
  const version = status.version ? `Version ${status.version}` : "Installed";
  switch (status.state) {
    case "not_installed":
      return [
        checking
          ? { ...install, ...looking }
          : { ...install, state: "todo", detail: "Not on this Mac yet" },
        waiting,
      ];
    case "outdated":
      return [
        checking
          ? { ...install, ...looking }
          : { ...install, state: "failed", detail: `${version} is too old to use here` },
        waiting,
      ];
    case "unavailable":
      return [
        checking
          ? { ...install, ...looking }
          : { ...install, state: "failed", detail: "Claude Code didn't answer" },
        waiting,
      ];
    case "signed_out":
      return [
        { ...install, state: "done", detail: version },
        checking
          ? { ...signIn, ...looking }
          : { ...signIn, state: "todo", detail: "Not signed in" },
      ];
    case "signed_in":
      return [
        { ...install, state: "done", detail: version },
        {
          ...signIn,
          state: "done",
          detail: status.plan ? `Signed in · ${planName(status.plan)} plan` : "Signed in",
        },
      ];
  }
}

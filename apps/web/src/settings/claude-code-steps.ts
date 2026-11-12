import type { ClaudeCodeStatus } from "@localdot/protocol";
import { t } from "../i18n/index.ts";
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
  const install = { id: "install", title: t`Install Claude Code` } as const;
  const signIn = { id: "sign-in", title: t`Sign in to Claude Code` } as const;
  const waiting = {
    ...signIn,
    state: "todo",
    detail: t`With your Claude plan, in Terminal`,
  } as const;
  const looking = { state: "doing", detail: t`Checking…` } as const;
  if (!status) return [{ ...install, ...looking }, waiting];
  const version = status.version ? t`Version ${status.version}` : t`Installed`;
  switch (status.state) {
    case "not_installed":
      return [
        checking
          ? { ...install, ...looking }
          : { ...install, state: "todo", detail: t`Not on this Mac yet` },
        waiting,
      ];
    case "outdated":
      return [
        checking
          ? { ...install, ...looking }
          : {
              ...install,
              state: "failed",
              detail: status.version
                ? t`Version ${status.version} is too old to use here`
                : t`Installed is too old to use here`,
            },
        waiting,
      ];
    case "unavailable":
      return [
        checking
          ? { ...install, ...looking }
          : { ...install, state: "failed", detail: t`Claude Code didn't answer` },
        waiting,
      ];
    case "signed_out":
      return [
        { ...install, state: "done", detail: version },
        checking
          ? { ...signIn, ...looking }
          : {
              ...signIn,
              state: "todo",
              detail: status.separate ? t`This dot's account isn't signed in` : t`Not signed in`,
            },
      ];
    case "signed_in":
      return [
        { ...install, state: "done", detail: version },
        {
          ...signIn,
          state: "done",
          detail: [
            status.separate ? t`Signed in on this dot` : t`Signed in`,
            ...(status.plan ? [t`${planName(status.plan)} plan`] : []),
          ].join(" · "),
        },
      ];
  }
}

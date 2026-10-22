// GET /api/access-links: the addresses this localDot can be opened at, and Tailscale's state.

export interface AccessAddress {
  origin: string;
  label: string;
}

// Tailscale on this computer, as the one next step toward opening localDot over it.
export type TailscaleState =
  | "not-installed"
  | "not-running"
  | "needs-login"
  | "needs-approval"
  | "ready-to-enable"
  | "served"
  | "unavailable";

export type TailscaleProblem =
  | "permission"
  | "port-taken"
  | "funnel"
  | "no-name"
  | "no-answer"
  | "other-user"
  | "failed";

export interface TailscaleAccess {
  state: TailscaleState;
  // What is wrong or what happens next, with the step that moves it on.
  message: string;
  // The tailnet address localDot is served at, or will be once turned on.
  origin?: string;
  // needs-approval: Tailscale's page that allows HTTPS for this computer.
  approvalUrl?: string;
  // unavailable: why.
  reason?: TailscaleProblem;
  // The command that lets this user share through Tailscale on Linux.
  operatorHint?: string;
}

export interface AccessLinksStatus {
  links: AccessAddress[];
  tailscale: TailscaleAccess;
}

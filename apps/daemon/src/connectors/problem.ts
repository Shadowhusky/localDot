import type { ConnectorStatus } from "@localdot/protocol";

// Why a connector can't be used, in words for the user, and the state it leaves the connector in.
export class ConnectorProblem extends Error {
  constructor(
    readonly status: Extract<ConnectorStatus, "needs_key" | "needs_sign_in" | "failed">,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorProblem";
  }
}

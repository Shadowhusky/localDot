import type { TakeoverInputRequest } from "@localdot/protocol";
import type { DesktopdClient } from "../desktopd/client.ts";
import { AgentError } from "./runner.ts";
import { type AgentSession, ControlHeldError } from "./session.ts";

export interface ManualDesktop {
  screen: { w: number; h: number };
  client: Pick<DesktopdClient, "input" | "type">;
  prepare(): Promise<void>;
  check(): void;
  release(): void;
}
// Root supplies the exact ready cell/endpoint owner. Plaintext never enters its journal or model.
export async function sendManualInput(
  session: AgentSession,
  request: TakeoverInputRequest,
  signal: AbortSignal,
  desktop: ((session: AgentSession) => ManualDesktop | undefined) | undefined,
): Promise<void> {
  const lease = session.admitManual(request.requestId, signal);
  const operation = AbortSignal.any([lease.signal, AbortSignal.timeout(30_000)]);
  let access: ManualDesktop | undefined;
  let dispatched = false;
  let confirmed = false;
  let failure: Error | undefined;
  const check = () => {
    operation.throwIfAborted();
    lease.check();
    access?.check();
  };
  try {
    access = desktop?.(session);
    if (!access) throw new AgentError(503, "manual control is unavailable");
    check();
    if (
      (request.input.kind === "click" || request.input.kind === "scroll") &&
      (request.input.at.x >= access.screen.w || request.input.at.y >= access.screen.h)
    )
      throw new AgentError(400, "input is outside the desktop");
    await access.prepare();
    check(); // Hand-back, Stop or endpoint replacement during preflight cannot deliver input.
    const input = request.input;
    dispatched = true;
    if (input.kind === "text") {
      const result = await access.client.type(
        {
          text: input.text,
          masked: true,
          pace: { firstMs: 0, firstCount: 0, restMs: 0 },
          injector: "xtest",
        },
        () => {}, // Discard even a malformed peer's plaintext progress.
        operation,
      );
      if (result.count !== [...input.text].length) throw new ManualInputUncertain();
    } else await access.client.input({ input, holdMs: 0, injector: "xtest" }, operation);
    check();
    confirmed = true;
  } catch (error) {
    failure = dispatched
      ? new ManualInputUncertain()
      : error instanceof AgentError
        ? error
        : operation.aborted || session.stopped || error instanceof ControlHeldError
          ? new ControlHeldError()
          : new AgentError(503, "manual control is unavailable");
  } finally {
    try {
      access?.release();
    } catch {
      confirmed = false;
      failure = new ManualInputUncertain();
    }
    lease.finish(dispatched && !confirmed);
  }
  if (failure) throw failure;
}
export class ManualInputUncertain extends Error {
  constructor() {
    super("manual input completion could not be confirmed; use Stop");
  }
}

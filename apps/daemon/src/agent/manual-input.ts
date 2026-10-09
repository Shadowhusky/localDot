import type { ManualStreamInput, TakeoverInputRequest } from "@localdot/protocol";
import type { BrowserScope } from "../browser/client.ts";
import type { DesktopdClient } from "../desktopd/client.ts";
import { AgentError } from "./runner.ts";
import { type AgentSession, ControlHeldError, type ManualLease } from "./session.ts";

export interface ManualDesktop {
  screen: { w: number; h: number };
  client: Pick<DesktopdClient, "input" | "type">;
  prepare(input: ManualStreamInput): Promise<void>;
  check(): void;
  release(): void;
  // Present on a screen that keeps a button down between inputs: lets go of every key and button
  // there, cancelling a drag rather than dropping it. A screen without it takes clicks only.
  letGo?(): Promise<void>;
}
export type ManualDesktopSource = (
  session: AgentSession,
  scope: BrowserScope,
) => ManualDesktop | undefined;

// Root supplies the exact ready cell/endpoint owner. Plaintext never enters its journal or model.
export async function sendManualInput(
  session: AgentSession,
  request: TakeoverInputRequest,
  signal: AbortSignal,
  desktop: ManualDesktopSource | undefined,
): Promise<void> {
  const lease = session.admitManual(request.requestId, signal);
  let access: ManualDesktop | undefined;
  let failure: Error | undefined;
  try {
    access = openManualDesktop(session, lease, desktop);
    await deliverManualInput(lease, access, request.input);
  } catch (error) {
    failure = manualFailure(error, lease, session);
  } finally {
    try {
      access?.release();
    } catch {
      failure = new ManualInputUncertain();
    }
    lease.finish(failure instanceof ManualInputUncertain);
  }
  if (failure) throw failure;
}

export function openManualDesktop(
  session: AgentSession,
  lease: ManualLease,
  desktop: ManualDesktopSource | undefined,
): ManualDesktop {
  const access = desktop?.(session, {
    signal: lease.signal,
    check: () => {
      lease.signal.throwIfAborted();
      lease.check();
    },
  });
  if (!access) throw new AgentError(503, "manual control is unavailable");
  return access;
}

// One input onto the screen. A failure once anything may have reached the computer is
// ManualInputUncertain: the fence then holds until Stop contains the desktop.
export async function deliverManualInput(
  lease: ManualLease,
  access: ManualDesktop,
  input: ManualStreamInput,
): Promise<void> {
  const operation = AbortSignal.any([lease.signal, AbortSignal.timeout(30_000)]);
  const check = () => {
    if (operation.aborted) throw new ControlHeldError();
    lease.check();
    access.check();
  };
  check();
  if ("at" in input && (input.at.x >= access.screen.w || input.at.y >= access.screen.h))
    throw new AgentError(400, "input is outside the desktop");
  await access.prepare(input);
  check(); // Hand-back, Stop or endpoint replacement during preflight cannot deliver input.
  try {
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
    } else
      await access.client.input(
        {
          input: input.kind === "move" ? { kind: "move", to: input.at } : input,
          holdMs: 0,
          injector: "xtest",
        },
        operation,
      );
    if (input.kind === "text" || input.kind === "key") lease.typed();
    check();
  } catch {
    throw new ManualInputUncertain();
  }
}

export function manualFailure(error: unknown, lease: ManualLease, session: AgentSession): Error {
  return error instanceof ManualInputUncertain
    ? error
    : error instanceof ManualInputRejected
      ? new AgentError(400, "manual control does not support that input")
      : error instanceof AgentError
        ? error
        : lease.signal.aborted || session.stopped || error instanceof ControlHeldError
          ? new ControlHeldError()
          : new AgentError(503, "manual control is unavailable");
}
export class ManualInputUncertain extends Error {
  constructor() {
    super("manual input completion could not be confirmed; use Stop");
  }
}
export class ManualInputRejected extends Error {}
